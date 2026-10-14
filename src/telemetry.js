import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CLIENT_VERSION, EVIDENCE_VERSION } from "./constants.js";
import { ensureDir, safeJsonRead, vibeHome } from "./utils.js";
import { INTENT_FIELDS } from "./intent.js";
import { buildArchitectureProfile } from "./data-intelligence.js";
import { getOrCreateSecret, readSecret, writeSecret } from "./secure-store.js";

const TELEMETRY_SCHEMA_VERSION = 4;
// Segments cap per-file work, not total undelivered data. Never silently trim
// the oldest unsent events during a long offline period.
const MAX_QUEUE_BYTES = 5 * 1024 * 1024;
const SEGMENT_NAME = /^queue-segment-\d{13}-[a-f0-9]{12}\.jsonl$/;
const segmentLineCountCache = new Map();

// Serialize queue mutations across simultaneous Codex/Agent MCP processes.
// 180ms worst-case contention is bounded; no content or credentials go to Cloud.
function withQueueMutationLock(action) {
  ensureDir(telemetryDir());
  const lock = path.join(telemetryDir(), ".queue-mutation.lock");
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let owned = false;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      owned = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000)
          fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      Atomics.wait(sleeper, 0, 0, 4);
    }
  }
  if (!owned) throw new Error("telemetry_queue_busy");
  try { return action(); }
  finally { try { fs.rmdirSync(lock); } catch {} }
}
const MAX_FINDINGS_PER_OBSERVATION = 50;

function telemetryDir() {
  return path.join(vibeHome(), "telemetry");
}

function configFile() {
  return path.join(telemetryDir(), "config.json");
}

function identityFile() {
  return path.join(telemetryDir(), "identity.json");
}

export function telemetryQueueFile() {
  return path.join(telemetryDir(), "queue.jsonl");
}

function writePrivateJson(file, value) {
  ensureDir(path.dirname(file));
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function readConfig() {
  return safeJsonRead(configFile(), { schemaVersion: 1, enabled: false });
}

let identityCache = null;

function ensureIdentity() {
  const file = identityFile();
  if (identityCache?.file === file && identityCache?.identity?.installationId && identityCache?.identity?.secret) {
    return identityCache.identity;
  }

  let identity = safeJsonRead(file, null);

  if (identity?.secret) {
    try {
      writeSecret("telemetry-hmac-secret", identity.secret);
      const scrubbed = { ...identity };
      delete scrubbed.secret;
      writePrivateJson(identityFile(), scrubbed);
      identity = scrubbed;
    } catch {}
  }

  if (!identity?.installationId) {
    identity = {
      schemaVersion: 1,
      installationId: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    };
    writePrivateJson(identityFile(), identity);
  }

  const secret = getOrCreateSecret("telemetry-hmac-secret", 32);
  const resolved = { ...identity, secret };
  identityCache = { file, identity: resolved };
  return resolved;
}

function pseudonym(secret, value) {
  if (!value) return null;
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex").slice(0, 32);
}

function telemetryQueueFiles() {
  const dir = telemetryDir();
  let segments = [];
  try {
    segments = fs.readdirSync(dir)
      .filter(name => SEGMENT_NAME.test(name))
      .sort()
      .map(name => path.join(dir, name));
  } catch { /* new installation: no queue yet */ }
  const current = telemetryQueueFile();
  if (fs.existsSync(current)) segments.push(current);
  return segments;
}

function queueCount() {
  let count = 0;
  for (const file of telemetryQueueFiles()) {
    const stat = fs.statSync(file);
    const cached = segmentLineCountCache.get(file);
    if (cached?.mtimeMs === stat.mtimeMs && cached?.size === stat.size) {
      count += cached.count;
      continue;
    }
    const number = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    segmentLineCountCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, count: number });
    count += number;
  }
  return count;
}

function compactQueue() {
  const file = telemetryQueueFile();
  if (!fs.existsSync(file) || fs.statSync(file).size <= MAX_QUEUE_BYTES) return;
  // Archive the complete immutable FIFO segment; the uploader drains oldest
  // segments first. Never discard unsent events to maintain the 5MB target.
  const archived = path.join(telemetryDir(),
    "queue-segment-" + String(Date.now()) + "-" + crypto.randomBytes(6).toString("hex") + ".jsonl");
  fs.renameSync(file, archived);
  segmentLineCountCache.delete(file);
}

function appendQueueMany(events) {
  const list = (events || []).filter(Boolean);
  if (!list.length) return 0;
  return withQueueMutationLock(() => {
    fs.appendFileSync(
      telemetryQueueFile(),
      list.map(event => JSON.stringify(event)).join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
    compactQueue();
    return list.length;
  });
}

function appendQueue(event) {
  return appendQueueMany([event]);
}

function metricBucket(value) {
  if (!Number.isFinite(Number(value))) return null;
  const n = Number(value);
  if (n < 1) return "lt1";
  if (n <= 2) return "1-2";
  if (n <= 5) return "3-5";
  if (n <= 10) return "6-10";
  if (n <= 20) return "11-20";
  if (n <= 50) return "21-50";
  if (n <= 100) return "51-100";
  if (n <= 250) return "101-250";
  if (n <= 500) return "251-500";
  if (n <= 1000) return "501-1000";
  if (n <= 2000) return "1001-2000";
  if (n <= 5000) return "2001-5000";
  return "gt5000";
}

function safeEnum(value, max = 48) {
  if (typeof value !== "string") return null;
  const trimmed = value.slice(0, max);
  return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : null;
}

function safeSignal(signal) {
  if (!signal?.name) return null;
  return {
    name: safeEnum(signal.name, 64),
    bucket: safeEnum(signal.bucket, 32),
    valueBucket: typeof signal.value === "number" ? metricBucket(signal.value) : safeEnum(signal.value, 32),
    independenceGroup: safeEnum(signal.independenceGroup, 64)
  };
}

function classifyActionMode(finding) {
  if (!finding) return null;
  const explicit = safeEnum(finding?.agentAction?.mode, 48);
  if (explicit) return explicit;
  if (finding?.semanticReview?.recommended) return "semantic-review";
  if (finding?.stage === "S5" || finding?.stage === "S4") return "staged-remediation";
  if (finding?.stage === "S3") return "next-change-watch";
  return "observe-only";
}

function findingPayload(finding) {
  return {
    score: Number.isFinite(finding?.score) ? Math.round(finding.score) : null,
    confidence: Number.isFinite(finding?.confidence) ? Number(finding.confidence.toFixed(2)) : null,
    evidenceQuality: safeEnum(finding?.evidenceQuality, 64),
    supportingSignalCount: Array.isArray(finding?.signals) ? finding.signals.length : 0,
    signals: (finding?.signals || []).map(safeSignal).filter(Boolean).slice(0, 24),
    actionMode: classifyActionMode(finding),
    semanticReviewRecommended: Boolean(finding?.semanticReview?.recommended)
  };
}

function boundedIntentValue(field, value) {
  return INTENT_FIELDS[field]?.includes(value) ? value : "unknown";
}

function telemetryIntent(productIntent) {
  // Product Intent is nested: effective is confirmed, inferred is a hypothesis.
  // Never silently promote inferred facts into the effective/explicit contract.
  const intent = {};
  const inferredIntent = {};
  const intentProvenance = {};
  for (const field of Object.keys(INTENT_FIELDS)) {
    intent[field] = boundedIntentValue(field, productIntent?.effective?.[field]);
    inferredIntent[field] = boundedIntentValue(field, productIntent?.inferred?.[field]);
    intentProvenance[field] = intent[field] !== "unknown"
      ? "explicit"
      : (inferredIntent[field] !== "unknown" ? "inferred" : "unknown");
  }
  return { intent, inferredIntent, intentProvenance };
}

function scanPayload(result, { dataIntelligenceEnabled = false } = {}) {
  const summary = result?.summary || {};
  const architectureProfile = dataIntelligenceEnabled ? buildArchitectureProfile(result) : null;
  const structural = summary.structuralScan || {};
  const monitoring = result?.monitoring || {};
  const intentTelemetry = telemetryIntent(result?.productIntent);
  return {
    reason: safeEnum(monitoring.deferReason || (monitoring.projectChanged ? "project_changed" : "observed"), 64),
    mode: safeEnum(monitoring.mode, 24),
    projectChanged: monitoring.projectChanged ?? null,
    durationMs: result?.durationMs ?? null,
    wallTimeMs: monitoring.wallTimeMs ?? null,
    scannerOverheadPct: monitoring.scannerOverheadPct ?? null,
    fullScanCount: monitoring.fullScanCount ?? null,
    cachedCheckCount: monitoring.cachedCheckCount ?? null,
    deferredCheckCount: monitoring.deferredCheckCount ?? null,
    phaseTimings: Object.fromEntries(
      Object.entries(monitoring.phaseTimings || {})
        .filter(([, value]) => Number.isFinite(Number(value)))
        .map(([key, value]) => [key, Math.max(0, Math.round(Number(value)))])
    ),
    sourceFilesBucket: metricBucket(summary.sourceFiles),
    totalLocBucket: metricBucket(summary.totalLoc),
    productionDependenciesBucket: metricBucket(summary.productionDependencies),
    testFilesBucket: metricBucket(summary.testFiles),
    graph: {
      edgeCountBucket: metricBucket(result?.graph?.edgeCount),
      cycleCountBucket: metricBucket(result?.graph?.cycleCount),
      maxFanInBucket: metricBucket(result?.graph?.maxFanIn),
      maxFanOutBucket: metricBucket(result?.graph?.maxFanOut)
    },
    structural: {
      mode: safeEnum(structural.mode, 24),
      candidateFiles: structural.candidateFiles ?? null,
      analyzedFiles: structural.analyzedFiles ?? null,
      skippedByBudget: structural.skippedByBudget ?? null,
      parserErrors: structural.parserErrors ?? null,
      languages: Array.isArray(structural.languages)
        ? structural.languages.map(value => safeEnum(value, 24)).filter(Boolean).slice(0, 12)
        : [],
      durationMs: structural.durationMs ?? null
    },
    ...intentTelemetry,
    ...(architectureProfile ? { architectureProfile } : {})
  };
}

function baseEvent(eventName, projectId = null, findingId = null, context = {}, config = readConfig()) {
  if (!config.enabled) return null;
  const identity = ensureIdentity();
  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    at: new Date().toISOString(),
    event: eventName,
    installationId: identity.installationId,
    projectId: pseudonym(identity.secret, context.projectInstanceId || projectId),
    repoId: pseudonym(identity.secret, context.repoId),
    projectInstanceId: pseudonym(identity.secret, context.projectInstanceId || projectId),
    findingId: pseudonym(identity.secret, findingId),
    sessionId: context.sessionId || null,
    callId: context.callId || null,
    scanId: context.scanId || null,
    clientVersion: CLIENT_VERSION,
    evidenceVersion: EVIDENCE_VERSION
  };
}

function scrubQueuedArchitectureProfiles() {
  return withQueueMutationLock(() => {
    for (const file of telemetryQueueFiles()) {
      const original = fs.readFileSync(file, "utf8");
      let changed = false;
      const lines = original.split("\n").map(line => {
        if (!line) return line;
        let event;
        try { event = JSON.parse(line); } catch { return line; }
        if (event?.payload && Object.hasOwn(event.payload, "architectureProfile")) {
          delete event.payload.architectureProfile;
          changed = true;
          return JSON.stringify(event);
        }
        return line;
      });
      if (!changed) continue;
      const temp = file + ".scrub-" + process.pid;
      try {
        fs.writeFileSync(temp, lines.join("\n"), { mode: 0o600 });
        fs.renameSync(temp, file);
        segmentLineCountCache.delete(file);
      } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
    }
  });
}

export function setTelemetryEnabled(enabled) {
  const previous = readConfig();
  if (enabled) ensureIdentity();
  const next = {
    ...previous,
    schemaVersion: 1,
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
    // Never erase a prior explicit V4 decision during setup or reinstalls.
    consentVersion: enabled
      ? (previous.consentVersion === "private-beta-v4" ? "private-beta-v4" : "private-beta-v3")
      : previous.consentVersion || null,
    dataIntelligenceEnabled: Boolean(enabled && previous.dataIntelligenceDecision !== "declined")
  };
  writePrivateJson(configFile(), next);
  if (!enabled) scrubQueuedArchitectureProfiles();
  return telemetryStatus();
}

/** The caller must obtain an explicit, versioned collection choice before enabling. */
export function setDataIntelligenceEnabled(enabled) {
  const previous = readConfig();
  if (enabled && !previous.enabled) throw new Error("telemetry_must_be_enabled");
  const next = {
    ...previous,
    dataIntelligenceEnabled: Boolean(enabled),
    dataIntelligenceDecision: enabled ? "accepted" : "declined",
    dataIntelligenceDecisionAt: new Date().toISOString(),
    ...(enabled ? { consentVersion: "private-beta-v4", dataIntelligenceNotice: "data-intelligence-v1" } : {}),
    updatedAt: new Date().toISOString()
  };
  writePrivateJson(configFile(), next);
  if (!enabled) scrubQueuedArchitectureProfiles();
  return telemetryStatus();
}

export function telemetryQueueAge() {
  const file = telemetryQueueFiles()[0];
  if (!file) return { oldestQueuedAt: null, oldestQueuedAgeMs: null };
  // Only the first event is needed; do not parse megabytes to get queue age.
  const fd = fs.openSync(file, "r");
  let first = "";
  try {
    // Normal events are small, but a legacy queued event may span 32KB.
    // Limit this read to 256KB to protect the interactive status path.
    const buf = Buffer.alloc(8192);
    let offset = 0;
    while (offset < 256 * 1024) {
      const count = fs.readSync(fd, buf, 0, buf.length, offset);
      if (!count) break;
      const data = buf.subarray(0, count).toString("utf8");
      const end = data.indexOf("\n");
      first += end >= 0 ? data.slice(0, end) : data;
      if (end >= 0) break;
      offset += count;
    }
  } finally { fs.closeSync(fd); }
  if (!first) return { oldestQueuedAt: null, oldestQueuedAgeMs: null };
  let at = null;
  try { at = JSON.parse(first).at; } catch {}
  const ms = typeof at === "string" ? Date.parse(at) : NaN;
  if (!Number.isFinite(ms)) return { oldestQueuedAt: null, oldestQueuedAgeMs: null };
  return { oldestQueuedAt: new Date(ms).toISOString(), oldestQueuedAgeMs: Math.max(0, Date.now() - ms) };
}

export function telemetryStatus() {
  const config = readConfig();
  const identity = safeJsonRead(identityFile(), null);
  const cloud = safeJsonRead(path.join(vibeHome(), "cloud", "client.json"), null);
  return {
    enabled: Boolean(config.enabled),
    consentVersion: config.consentVersion || null,
    dataIntelligenceEnabled: Boolean(config.enabled && config.dataIntelligenceDecision !== "declined"),
    dataIntelligenceDecision: config.dataIntelligenceDecision || null,
    installationId: identity?.installationId || null,
    queuedEvents: queueCount(),
    queuedSegmentCount: Math.max(0, telemetryQueueFiles().length - (fs.existsSync(telemetryQueueFile()) ? 1 : 0)),
    ...telemetryQueueAge(),
    syncDiagnostics: safeJsonRead(path.join(vibeHome(), "cloud", "telemetry-sync.json"), null),
    cloudTransportConfigured: Boolean(
      cloud?.baseUrl && readSecret("cloud-installation-token")
    ),
    queueFile: telemetryQueueFile()
  };
}

export function inspectTelemetryQueue({ limit = 50 } = {}) {
  const file = telemetryQueueFile();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(0, Math.max(1, limit))
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

// Lifecycle events are tiny, explicit install/uninstall observations. They are
// persisted before any network request, and never contain paths or source code.
export function enqueueLifecycleTelemetry(event, { scope = "full", agents = [], remainingAgents = [], reusedActivation = false } = {}) {
  if (!["lifecycle.installed", "lifecycle.uninstalled", "lifecycle.integration_removed"].includes(event)) return null;
  const base = baseEvent(event);
  if (!base) return null;
  const allowed = new Set(["codex", "claude", "cursor", "antigravity", "trae"]);
  const safeAgents = Array.from(new Set(agents.filter(agent => allowed.has(agent))));
  const safeRemaining = Array.from(new Set(remainingAgents.filter(agent => allowed.has(agent))));
  const item = {
    ...base,
    agent: "cli",
    payload: {
      lifecycle: {
        scope: scope === "partial" ? "partial" : "full",
        agents: safeAgents,
        remainingAgents: safeRemaining,
        reusedActivation: reusedActivation === true
      }
    }
  };
  appendQueue(item);
  return item;
}

export function enqueueActivityTelemetry(activityItem, transitions = [], result = null) {
  const context = {
    sessionId: activityItem.sessionId || null,
    callId: activityItem.callId || null,
    scanId: activityItem.scanId || result?.monitoring?.scanId || null,
    repoId: activityItem.repoId || result?.project?.repoId || null,
    projectInstanceId: activityItem.projectInstanceId || result?.project?.projectInstanceId || activityItem.projectId || null
  };
  // Reuse one config read across all observation events in this batch.
  const telemetryConfig = readConfig();
  const base = baseEvent(activityItem.event, activityItem.projectId, activityItem.findingId, context, telemetryConfig);
  if (!base) return 0;

  const queued = [{
    ...base,
    agent: activityItem.agent || "unknown",
    stage: activityItem.stage || null,
    family: activityItem.family || null,
    attentionRequired: activityItem.attentionRequired ?? null,
    findingCount: activityItem.findingCount ?? null,
    attentionCount: activityItem.attentionCount ?? null,
    durationMs: activityItem.durationMs ?? null,
    monitoringMode: activityItem.monitoringMode || null,
    monitoringWallTimeMs: activityItem.monitoringWallTimeMs ?? null,
    scannerOverheadPct: activityItem.scannerOverheadPct ?? null,
    payload: {
      call: {
        event: safeEnum(activityItem.event, 48),
        monitoringMode: safeEnum(activityItem.monitoringMode, 24)
      }
    }
  }];

  if (result) {
    // Same private-beta telemetry category: emit unless explicitly declined.
    // Data is computed from a full scan only; no extra scan, event or network request.
    const dataIntelligenceEnabled = telemetryConfig.enabled && telemetryConfig.dataIntelligenceDecision !== "declined";
    const scanBase = baseEvent("scan.observed", activityItem.projectId, null, context, telemetryConfig);
    if (scanBase) {
      queued.push({
        ...scanBase,
        agent: activityItem.agent || "unknown",
        stage: result?.status?.highestStage || null,
        attentionRequired: result?.status?.attentionRequired ?? null,
        findingCount: result?.status?.findingCount ?? null,
        attentionCount: result?.status?.attentionCount ?? null,
        durationMs: result?.durationMs ?? null,
        monitoringMode: result?.monitoring?.mode || null,
        monitoringWallTimeMs: result?.monitoring?.wallTimeMs ?? null,
        scannerOverheadPct: result?.monitoring?.scannerOverheadPct ?? null,
        payload: scanPayload(result, { dataIntelligenceEnabled })
      });
    }

    for (const finding of (result.findings || []).slice(0, MAX_FINDINGS_PER_OBSERVATION)) {
      const findingBase = baseEvent("finding.observed", activityItem.projectId, finding.id, context, telemetryConfig);
      if (!findingBase) continue;
      queued.push({
        ...findingBase,
        agent: activityItem.agent || "unknown",
        family: finding.family || null,
        stage: finding.stage || null,
        attentionRequired: finding.requiresAttention ?? null,
        actionMode: classifyActionMode(finding),
        payload: findingPayload(finding)
      });
    }
  }

  for (const transition of transitions || []) {
    // The current Cloud schema only accepts observed stage changes. A missing
    // Finding is not evidence of a repair; keep it local until Outcome v1.
    if (!transition?.id || !transition?.type || transition.type === "unverified_disappearance") continue;
    const transitionBase = baseEvent("finding." + transition.type, activityItem.projectId, transition.id, context, telemetryConfig);
    if (!transitionBase) continue;
    const currentFinding = (result?.findings || []).find(finding => finding.id === transition.id);
    queued.push({
      ...transitionBase,
      agent: activityItem.agent || "unknown",
      family: transition.family || null,
      fromStage: transition.fromStage || null,
      toStage: transition.toStage || null,
      actionMode: classifyActionMode(currentFinding),
      payload: {
        transitionType: safeEnum(transition.type, 32),
        currentActionMode: classifyActionMode(currentFinding)
      }
    });
  }

  return appendQueueMany(queued);
}


export function enqueueNoticeTelemetry({
  agent = "unknown",
  projectId,
  repoId = null,
  projectInstanceId = null,
  sessionId = null,
  callId = null,
  scanId = null,
  surfacedFindings = [],
  suppressedCount = 0,
  maxNotices = null
}) {
  let added = 0;
  for (const finding of surfacedFindings || []) {
    const base = baseEvent("notice.surfaced", projectId, finding?.id, {
      sessionId,
      callId,
      scanId,
      repoId,
      projectInstanceId
    });
    if (!base) continue;
    appendQueue({
      ...base,
      agent,
      family: finding?.family || null,
      stage: finding?.stage || null,
      attentionRequired: true,
      actionMode: classifyActionMode(finding),
      payload: {
        actionMode: classifyActionMode(finding),
        semanticReviewRecommended: Boolean(finding?.semanticReview?.recommended)
      }
    });
    added += 1;
  }

  if (suppressedCount > 0) {
    const base = baseEvent("notice.suppressed", projectId, null, {
      sessionId,
      callId,
      scanId,
      repoId,
      projectInstanceId
    });
    if (base) {
      appendQueue({
        ...base,
        agent,
        attentionRequired: true,
        payload: {
          suppressedCount: Math.max(0, Math.trunc(suppressedCount)),
          maxNotices: Number.isFinite(maxNotices) ? Math.max(0, Math.trunc(maxNotices)) : null
        }
      });
      added += 1;
    }
  }
  return added;
}

export function enqueueFeedbackTelemetry(feedbackItem) {
  const base = baseEvent(
    "feedback." + feedbackItem.verdict,
    feedbackItem.projectId,
    feedbackItem.findingId,
    {
      sessionId: feedbackItem.sessionId || null,
      callId: feedbackItem.callId || null,
      scanId: feedbackItem.scanId || null,
      repoId: feedbackItem.repoId || null,
      projectInstanceId: feedbackItem.projectInstanceId || feedbackItem.projectId || null
    }
  );
  if (!base) return false;
  appendQueue({
    ...base,
    agent: feedbackItem.agent || "unknown",
    family: feedbackItem.family || null,
    stage: feedbackItem.stage || null,
    verdict: feedbackItem.verdict,
    actionMode: safeEnum(feedbackItem.actionMode, 48),
    payload: {
      actionMode: safeEnum(feedbackItem.actionMode, 48),
      verdict: safeEnum(feedbackItem.verdict, 32)
    }
  });
  return true;
}

export function enqueueCallCompletedTelemetry({
  agent = "unknown",
  projectId,
  repoId = null,
  projectInstanceId = null,
  sessionId = null,
  callId = null,
  scanId = null,
  toolEvent,
  toolMs = null,
  telemetryQueueMs = null,
  result = null
}) {
  const base = baseEvent("call.completed", projectId, null, {
    sessionId,
    callId,
    scanId,
    repoId,
    projectInstanceId
  });
  if (!base) return false;
  appendQueue({
    ...base,
    agent,
    stage: result?.status?.highestStage || null,
    findingCount: result?.status?.findingCount ?? null,
    attentionCount: result?.status?.attentionCount ?? null,
    monitoringMode: result?.monitoring?.mode || null,
    monitoringWallTimeMs: result?.monitoring?.wallTimeMs ?? null,
    scannerOverheadPct: result?.monitoring?.scannerOverheadPct ?? null,
    payload: {
      toolEvent: safeEnum(toolEvent, 48),
      timings: {
        ...Object.fromEntries(
          Object.entries(result?.monitoring?.phaseTimings || {})
            .filter(([, value]) => Number.isFinite(Number(value)))
            .map(([key, value]) => [key, Math.max(0, Math.round(Number(value)))])
        ),
        toolMs: Number.isFinite(Number(toolMs)) ? Math.max(0, Math.round(Number(toolMs))) : null,
        telemetryQueueMs: Number.isFinite(Number(telemetryQueueMs))
          ? Math.max(0, Math.round(Number(telemetryQueueMs)))
          : null
      }
    }
  });
  return true;
}

export function readTelemetryBatch({ limit = 100 } = {}) {
  const file = telemetryQueueFiles()[0];
  if (!file) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(0, Math.max(1, limit))
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function acknowledgeTelemetryEvents(eventIds = []) {
  const ids = new Set(eventIds.filter(Boolean));
  if (!ids.size) return 0;
  return withQueueMutationLock(() => {
  let acknowledged = 0;
  for (const file of telemetryQueueFiles()) {
    if (!ids.size) break;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const remaining = [];
    for (const line of lines) {
      let event = null;
      try { event = JSON.parse(line); } catch {}
      if (event?.eventId && ids.has(event.eventId)) {
        acknowledged += 1;
        ids.delete(event.eventId);
      } else remaining.push(line); // preserve any unrecognized event verbatim
    }
    if (lines.length === remaining.length) continue;
    segmentLineCountCache.delete(file);
    if (!remaining.length && file !== telemetryQueueFile()) {
      fs.rmSync(file, { force: true });
    } else {
      const temp = file + ".ack-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
      try {
        fs.writeFileSync(temp, remaining.join("\n") + (remaining.length ? "\n" : ""),
          { encoding: "utf8", mode: 0o600 });
        fs.renameSync(temp, file);
      } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
    }
  }
  return acknowledged;
  });
}
