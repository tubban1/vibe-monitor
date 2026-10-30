import fs from "node:fs";
import { ALL_AGENT_NAMES } from "./agent-integrations.js";
import nodePath from "node:path";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { appendActivity, detectAgentHost } from "./activity.js";
import { createMonitoringBudgetSession } from "./budget.js";
import { runInterruptibleScan, ScanControlError } from "./interruptible-scan.js";
import { appendFeedback } from "./feedback.js";
import { loadState } from "./history.js";
import { findProjectRoot, projectIdentity } from "./project.js";
import { recordOutcomeAction, recordOutcomeVerification, listOutcomeRecords } from "./outcomes.js";
import { saveExplicitIntent } from "./intent.js";
import { markSurfacedNotices, shouldSurfaceNotice } from "./notices.js";
import {
  createArchitectureReview,
  fetchRemotePolicy,
  submitArchitectureReviewResponse,
  syncCloudDevice,
  syncTelemetry,
  createFreeTelemetryDrain
} from "./cloud.js";
import {
  ARP_PROTOCOL_VERSION,
  buildArchitectureReviewRequest,
  describeArchitectureReviewEligibility,
  cloudArchitectureReviewResponse,
  findReusableArchitectureReview,
  loadArchitectureReview,
  persistArchitectureReviewRequest,
  persistArchitectureReviewResponse
} from "./architecture-review.js";
import { enqueueCallCompletedTelemetry, enqueueNoticeTelemetry, enqueueOutcomeTelemetry, initializeFreeTelemetry } from "./telemetry.js";
import { CLIENT_VERSION } from "./constants.js";
import { isOpenClientDistribution, resolveDistributionPolicy, freeAnalysisContractStatus } from "./distribution.js";
import { findingDetail } from "./finding-detail.js";
import { auditLegacyCode } from "./legacy-audit.js";
import { detectorRuleId, monitorFamilyForDetector } from "./rule-identity.js";
import { recommendationGroups } from "./diagnostic-quality.js";
import { highSeverityReviewQueue } from "./finding-intelligence.js";
import { compareVersions, consumeUpdateNotice, observeAvailableUpdate, scheduleAutomaticUpdate, updateStatus } from "./update.js";

function textResult(value) {
  const runtimeNotice = consumeUpdateNotice();
  const payload = runtimeNotice && value && typeof value === "object" && !Array.isArray(value)
    ? { ...value, runtimeNotice }
    : value;
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function recordCallTiming(result, callStartedAt) {
  if (!result?.monitoring) return;
  result.monitoring.scanDurationMs = Number.isFinite(result.durationMs) ? result.durationMs : null;
  result.monitoring.handlerElapsedMs = Math.max(0, Date.now() - callStartedAt);
  result.monitoring.timingScope = "scanDurationMs measures analysis work (0 for a cache hit); handlerElapsedMs measures this MCP handler call and excludes client transport. Nested phase timings must not be summed.";
}

function compactAttentionFinding(finding) {
  return {
    id: finding.id,
    ruleId: finding.ruleId || detectorRuleId(finding.family),
    family: finding.family,
    stage: finding.stage,
    target: finding.target,
    requiresAttention: finding.requiresAttention,
    userFacing: finding.userFacing,
    agentAction: finding.agentAction || null,
    semanticReview: finding.semanticReview || null,
    // Preserve measured values and provenance in alerts, not just stage labels.
    evidenceQuality: finding.evidenceQuality || "unknown",
    boundaryAssessment: finding.boundaryAssessment || null,
    signals: (finding.signals || []).map(s => ({
      name: s.name, value: s.value ?? null, evidence: s.evidence || null,
      bucket: s.bucket || null, independenceGroup: s.independenceGroup || s.name
    })),
    intelligence: finding.intelligence ? {
      trend: finding.intelligence.trend,
      observedScans: finding.intelligence.observedScans,
      scoreDelta: finding.intelligence.scoreDelta,
      priority: finding.intelligence.priority,
      decision: finding.intelligence.decision,
      severityReview: finding.intelligence.severityReview,
      intentContext: finding.intelligence.intentContext
    } : null
  };
}

function improvementNotice(change) {
  const target = change.target === "project" ? "这个项目" : change.target;
  return {
    type: "improved",
    id: change.id,
    target: change.target,
    fromStage: change.fromStage,
    toStage: change.toStage,
    message: `${target} 的情况正在变好：从 ${change.fromStage} 降到 ${change.toStage}。说明最近的开发没有继续把这个问题往坏的方向推。`
  };
}

function selectNoticeFindings(findings, maxNotices = 2) {
  const selected = [];
  const families = new Set();
  const ranked = [...findings].sort((a,b) =>
    (b.intelligence?.priority ?? 0) - (a.intelligence?.priority ?? 0));
  for (const finding of ranked) {
    if (families.has(finding.family)) continue;
    selected.push(finding);
    families.add(finding.family);
    if (selected.length >= maxNotices) break;
  }
  return selected;
}

export function buildAgentResult(result, { sessionStart = false, attentionFilter = null, maxNotices = 2 } = {}) {
  const allAttention = result.findings
    .filter(f => f.requiresAttention)
    .map(compactAttentionFinding);
  const changedIds = new Set(
    (result.transitions || [])
      .filter(change => change.type === "new_attention" || change.type === "worsened")
      .map(change => change.id)
  );
  // Never surface stale architecture warnings as a fresh assessment.
  const baseEligibleAttention = result?.monitoring?.assessmentAvailable === false
    ? []
    : sessionStart ? allAttention
    : allAttention.filter(finding => changedIds.has(finding.id));
  const eligibleAttention = attentionFilter
    ? baseEligibleAttention.filter(attentionFilter)
    : baseEligibleAttention;
  // Read source only for selected notices; telemetry exports a separate,
  // aggregate allowlist and never receives excerpts or file paths.
  const attentionFindings = selectNoticeFindings(eligibleAttention, Math.max(0, maxNotices))
    .map(notice => {
      const original = result.findings.find(f => f.id === notice.id);
      let sourceEvidence = [];
      try {
        sourceEvidence = findingDetail(result.project?.root, original, result.summary)
          ?.explanation?.sourceEvidence?.slice(0, 5) || [];
      } catch { /* unavailable files must never be interpreted as clean */ }
      const coverage = result.summary?.structuralScan || null;
      const semanticStatus = original?.boundaryAssessment?.status || null;
      return {
        ...notice,
        evidenceSummary: {
          capturedAt: result.capturedAt || null,
          quality: original?.evidenceQuality || "unknown",
          assessment: semanticStatus || (sourceEvidence.length ? "source-indicators-only" : "aggregate-signals-only"),
          verificationRequired: !original?.structuralEvidence?.boundaryCandidateCount,
          sourceEvidence,
          structuralCoverage: coverage ? {
            candidateFiles: coverage.candidateFiles ?? 0,
            analyzedFiles: coverage.analyzedFiles ?? 0,
            skippedByBudget: coverage.skippedByBudget ?? 0
          } : null,
          limitation: "Signals and source indicators do not prove a refactor is needed. Verify responsibilities and actual consumers first."
        }
      };
    });
  const improvements = (result?.monitoring?.assessmentAvailable === false ? [] : result.transitions || [])
    .filter(change => change.type === "improved" && ["S3", "S4", "S5"].includes(change.fromStage))
    .slice(0, 1)
    .map(improvementNotice);
  // An unfinished large-project scan is not a clean architecture report.
  // Tell the Agent once at session start without repeatedly nagging at every
  // checkpoint or inventing a fresh S4/S5 finding from partial evidence.
  const evidenceIncomplete = result?.status?.assessmentAvailable === false &&
    result?.monitoring?.deferReason === "evidence_budget_exceeded";
  const assessmentNotice = evidenceIncomplete ? {
    code: "architecture_assessment_incomplete",
    reason: result.monitoring.budgetPhase || "scan_budget",
    userFacing: "Vibe Monitor 没有完成本次架构检查：项目超出了当前扫描预算。状态为未知，不代表架构健康。请检查单个较小的项目，或稍后重试。"
  } : null;

  return {
    schemaVersion: result.schemaVersion,
    project: result.project,
    capturedAt: result.capturedAt,
    durationMs: result.durationMs,
    status: result.status,
    monitoring: result.monitoring || null,
    watchCount: result.findings.filter(f => f.stage === "S2").length,
    userNoticeRequired: attentionFindings.length > 0 || improvements.length > 0 ||
      Boolean(sessionStart && assessmentNotice),
    ...(assessmentNotice ? {assessmentNotice} : {}),
    ...(assessmentNotice && sessionStart ? {userFacing:assessmentNotice.userFacing} : {}),
    attentionFindings,
    suppressedAttentionCount: Math.max(0, baseEligibleAttention.length - attentionFindings.length),
    improvements
  };
}


export function applyMonitoringPolicy(result, policy = {}) {
  const enabled = policy.enabledMonitors || {};
  const isEnabled = family => enabled[family] !== false;
  const findings = result.findings
    .filter(finding => isEnabled(monitorFamilyForDetector(finding.family)))
    .map(finding => ({
      ...finding,
      ruleId: finding.ruleId || detectorRuleId(finding.family)
    }));
  const activeIds = new Set(findings.map(finding => finding.id));
  const transitions = (result.transitions || []).filter(change =>
    (change.family ? isEnabled(monitorFamilyForDetector(change.family)) : activeIds.has(change.id))
  );
  const attention = findings.filter(finding => finding.requiresAttention);
  return {
    ...result,
    findings,
    transitions,
    status: result?.status?.assessmentAvailable === false
      ? { assessmentAvailable: false, highestStage: "unknown",
          attentionRequired: false, findingCount: null, attentionCount: null }
      : {
        assessmentAvailable: true,
        attentionRequired: attention.length > 0,
        highestStage: findings[0]?.stage || "S1",
        findingCount: findings.length,
        attentionCount: attention.length
      }
  };
}

// A failed control-plane check must not masquerade as a deliberate remote disable.
export function buildDisabledPolicyPayload(remotePolicy) {
  const unavailable = remotePolicy.source === "fail-closed";
  const reason = remotePolicy.reason || "remote_service_control";
  const disabledBy = unavailable
    ? (reason === "cloud_not_registered" ? "not_registered"
      : remotePolicy.diagnostic?.code === "service_control_unauthorized"
        ? "authorization_failed" : "service_unavailable")
    : (reason === "telemetry_required" ? "telemetry" : "remote");
  const nextAction = reason === "cloud_not_registered"
    ? "Complete cloud activation; check vibe-monitor doctor --json."
    : reason === "telemetry_required"
      ? "Free architecture analysis requires product-improvement telemetry. Telemetry settings are managed on the Vibe Monitor website."
      : unavailable && remotePolicy.diagnostic?.code === "service_control_unauthorized"
        ? "Cloud authorization failed. Contact beta support; never share tokens."
        : unavailable
          ? "Check connectivity and retry vibe-monitor cloud config --force."
          : null;
  return {
    serviceEnabled: false,
    disabledBy,
    policySource: remotePolicy.source,
    policyProfile: remotePolicy.profile || null,
    policyVersion: remotePolicy.version || null,
    userNoticeRequired: unavailable,
    status: {
      assessmentAvailable: false,
      attentionRequired: false,
      highestStage: "unknown",
      findingCount: null,
      attentionCount: null
    },
    monitoring: {
      mode: unavailable ? "unavailable" : "disabled",
      reason,
      ...(unavailable && remotePolicy.diagnostic ? { diagnostic: remotePolicy.diagnostic } : {}),
      ...(nextAction ? { nextAction } : {})
    }
  };
}

// A Launcher pointer can change while a session-scoped MCP process remains alive.
// Report the actual loaded bundle separately from the installed runtime pointer.
export function buildVersionToolPayload(status, runningProcessVersion = CLIENT_VERSION) {
  return {
    product: "Vibe Monitor",
    clientVersion: runningProcessVersion,
    runningProcessVersion,
    installedCurrentVersion: status.currentVersion,
    runtimeVersionMatchesInstalled: runningProcessVersion === status.currentVersion,
    previousVersion: status.previousVersion,
    stagedVersion: status.stagedVersion,
    updateAvailable: status.available,
    updateChannel: status.channel,
    latestVersion: status.latestVersion,
    latestVersionScope: "Cloud policy advertised version for this installation/channel, not the latest published npm version.",
    latestVersionBehindInstalled: Boolean(status.latestVersion && compareVersions(status.latestVersion, status.currentVersion) < 0),
    activateOnNextStart: status.activateOnNextStart
  };
}

// A skipped or timed-out scan never claims that a project is healthy.
export function buildSkippedSessionPayload(reason = "user_skipped", callId = null, elapsedMs = 0) {
  const mode = reason === "scan_timeout" ? "timeout" : reason === "scan_cancelled" || reason === "user_skipped" ? "skipped" : "unavailable";
  return {
    serviceEnabled: null,
    callId,
    userNoticeRequired: mode !== "skipped",
    status: { assessmentAvailable: false, attentionRequired: false,
      highestStage: "unknown", findingCount: null, attentionCount: null },
    monitoring: {
      mode,
      reason,
      elapsedMs,
      nextAction: mode === "timeout"
        ? "Continue coding. Vibe Monitor scan timed out; retry at a later checkpoint. No architecture assessment was completed."
        : mode === "skipped"
          ? "Continue coding normally. Vibe Monitor was skipped for this request; no architecture assessment was completed."
          : "Continue coding normally and use vibe-monitor doctor --json to diagnose scan availability."
    }
  };
}

export function isFilesystemRoot(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  const normalized = candidate.split(String.fromCharCode(92)).join("/").replace(/\/+/g, "/");
  if (normalized === "/" || /^[a-zA-Z]:\/?$/.test(normalized)) return true;
  try {
    const resolved = nodePath.resolve(candidate);
    return resolved === nodePath.parse(resolved).root;
  } catch {
    return false;
  }
}

// IDE launchers often start MCP with their *application installation* as
// cwd, not the editor's open workspace. Scanning such directories can appear
// healthy while failing to inspect any user code. Require an explicit project
// selection unless cwd can genuinely be identified as a project.
export function isSafeImplicitProjectCwd(candidate) {
  if (typeof candidate !== "string" || !candidate.trim()) return false;
  if (isFilesystemRoot(candidate)) return false;
  const normalized = candidate.split(String.fromCharCode(92)).join("/").replace(/\/+/g, "/").toLowerCase();
  if (normalized.includes("/appdata/local/programs/") ||
      normalized.includes("/program files/") ||
      normalized.includes("/program files (x86)/")) return false;
  try {
    const root = findProjectRoot(candidate);
    if (isFilesystemRoot(root)) return false;
    return fs.existsSync(nodePath.join(root, ".git")) ||
      ["package.json", "pyproject.toml", "Cargo.toml", "go.mod"].some(
        filename => fs.existsSync(nodePath.join(root, filename))
      );
  } catch {
    return false;
  }
}

export function projectPathRequiredPayload() {
  return {
    serviceEnabled: null,
    disabledBy: "project_selection",
    status: { assessmentAvailable: false, attentionRequired: false,
      highestStage: "unknown", findingCount: null, attentionCount: null },
    monitoring: { mode: "unavailable", reason: "project_path_required",
      nextAction: "Pass the absolute path of the open coding project to vibe_session_start or vibe_project_status. The IDE installation directory is not a coding project." }
  };
}

// Scoped to one MCP server instance. Never share a host's project path
// between Agent processes. Successful assessments bind the implicit target.
export function createMcpProjectContext(cwd = () => process.cwd()) {
  let confirmedRoot = null;
  let lastExplicitSuccess = 0;
  let nextExplicitOrder = 0;
  return {
    resolve(inputPath) {
      const explicit = typeof inputPath === "string" && inputPath.trim().length > 0;
      return {
        path: explicit ? inputPath : (confirmedRoot || cwd()),
        explicit,
        fallbackToHostCwd: !explicit && !confirmedRoot,
        order: explicit ? ++nextExplicitOrder : 0
      };
    },
    confirm(selection, result) {
      // Never bind failed, disabled, partial or deferred assessments.
      if (result?.status?.assessmentAvailable !== true ||
          typeof result?.project?.root !== "string" ||
          !result.project.root) return;
      if (selection.explicit) {
        // Late older calls must not override a newer confirmed selection.
        if (selection.order > lastExplicitSuccess) {
          confirmedRoot = result.project.root;
          lastExplicitSuccess = selection.order;
        }
      } else if (!confirmedRoot) {
        confirmedRoot = result.project.root;
      }
    }
  };
}

// Direct npm / npx / agent-managed MCP installs may bypass setup.
// On a first open-client boot, telemetry defaults ON. An existing explicit
// opt-out remains unchanged across restarts.
export function initializeMcpTelemetry() {
  if (isOpenClientDistribution()) return initializeFreeTelemetry();
  return null;
}

export async function runMcpServer({ agent: explicitAgent = null } = {}) {
  initializeMcpTelemetry();
  const server = new McpServer({ name: "vibe-monitor", version: CLIENT_VERSION });
  const allowedAgents = new Set(ALL_AGENT_NAMES);
  const agent = allowedAgents.has(explicitAgent) ? explicitAgent : detectAgentHost();
  const sessionId = crypto.randomUUID();
  const budget = createMonitoringBudgetSession();
  const projectContext = createMcpProjectContext();
  const activeSessionScans = new Set();
  if(!isOpenClientDistribution())void syncCloudDevice().catch(() => {});
  let noticesShownThisSession = 0;
  const pathSchema = z.string().optional().describe("Absolute path to ONE coding project (prefer its Git repository root), NOT the IDE's application folder or a parent of multiple repositories. When omitted, uses the last successfully assessed project or a recognizable Git/project cwd; otherwise returns project_path_required.");

  server.registerTool("vibe_version", {
    description: "Get the Vibe Monitor version currently running in this MCP process, the installed current/previous runtime versions, staged update, and update state. A process may still run an older bundle after the installed pointer changes. Use this tool when the user asks which Vibe Monitor version is running or installed. schemaVersion and evidenceVersion are data format versions, NOT the software version.",
    inputSchema: {}
  }, async () => {
    const status = await updateStatus({ refresh: false });
    return textResult(buildVersionToolPayload(status));
  });

  // Account linking always starts on the website, which issues the one-time
  // prompt. This tool only tells the agent where to send the human.
  if(isOpenClientDistribution()){
   server.registerTool("vibe_account_connect",{
    description:"Explain how to link this Vibe Monitor installation to the user's account. Call ONLY when the human asks to link this device. Makes no network request.",
    inputSchema:{project_path:z.string().optional().describe("Ignored; kept for compatibility.")}
   },async()=>textResult({status:"start_on_website",
    url:"https://vibe.fde.fan/app/",
    nextAction:"Ask the human to sign in at https://vibe.fde.fan/app/, click \"Add device\" and paste the copied prompt here. Then run the single command in that prompt."}));
  }

  const disabledPayload = buildDisabledPolicyPayload;

  // MCP cancellation must also interrupt the cloud policy wait, not merely
  // the scanner. Promise.race attaches a rejection handler to the policy promise.
  async function cancelAware(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) throw new ScanControlError("scan_cancelled");
    let onAbort;
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(new ScanControlError("scan_cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try { return await Promise.race([promise, interrupted]); }
    finally { signal.removeEventListener("abort", onAbort); }
  }

  async function analyzeWithPolicy(
    inputPath,
    { persist, kind, forcePolicy = false, callId = crypto.randomUUID(), interruptible = false, signal = null, onPhase = null } = {}
  ) {
    if (signal?.aborted) throw new ScanControlError("scan_cancelled");
    const selection = projectContext.resolve(inputPath);
    if (isFilesystemRoot(selection.path) || (selection.fallbackToHostCwd && !isSafeImplicitProjectCwd(selection.path))) {
      return { result: null, remotePolicy: null, disabled: true, callId,
        disabledPayload: projectPathRequiredPayload() };
    }
    onPhase?.("policy");
    const policyStartedAt = Date.now();
    const remotePolicy = await cancelAware(resolveDistributionPolicy({fetchPolicy:fetchRemotePolicy,force:forcePolicy}),signal);
    if (signal?.aborted) throw new ScanControlError("scan_cancelled");
    const policyMs = Date.now() - policyStartedAt;
    observeAvailableUpdate(remotePolicy.update || {});
    if (remotePolicy.enabled === false) {
      return {
        result: null,
        remotePolicy,
        disabled: true,
        callId,
        disabledPayload: disabledPayload(remotePolicy)
      };
    }

    const analysisStartedAt = Date.now();
    onPhase?.("analysis");
    const raw = interruptible
      ? await runInterruptibleScan({
        inputPath: selection.path, persist, kind, policy: remotePolicy.config
      }, { signal, timeoutMs: 10_000 })
      : budget.analyze(selection.path, {
        persist, kind, policy: remotePolicy.config
      });
    const analysisMs = Date.now() - analysisStartedAt;
    // Telemetry may be disabled in another process while a scan is running.
    if(isOpenClientDistribution()&&!freeAnalysisContractStatus().serviceEnabled){
      const access={enabled:false,source:"free-service-contract",reason:"telemetry_required"};
      return {result:null,remotePolicy:access,disabled:true,callId,
        disabledPayload:disabledPayload(access)};
    }
    const result = applyMonitoringPolicy(raw, remotePolicy.config);
    result.monitoring = {
      ...(result.monitoring || {}),
      callId,
      phaseTimings: {
        ...(result.monitoring?.phaseTimings || {}),
        policyMs,
        analysisMs
      }
    };
    projectContext.confirm(selection, result);
    return {
      result,
      remotePolicy,
      disabled: false,
      callId
    };
  }

  const freeTelemetryDrain = isOpenClientDistribution() ? createFreeTelemetryDrain() : null;
  let cloudSyncPromise = null;
  let cloudSyncRequested = false;

  function syncCloudBestEffort() {
    if(freeTelemetryDrain)return freeTelemetryDrain.request();
    cloudSyncRequested = true;
    if (cloudSyncPromise) return cloudSyncPromise;

    cloudSyncPromise = (async () => {
      while (cloudSyncRequested) {
        cloudSyncRequested = false;
        await syncTelemetry({ limit: 100, respectBackoff: true });
      }
    })()
      .catch(() => {})
      .finally(() => {
        cloudSyncPromise = null;
        if (cloudSyncRequested) syncCloudBestEffort();
      });

    return cloudSyncPromise;
  }

  function recordActivity(event, options = {}) {
    return appendActivity(event, { ...options, sessionId });
  }

  function actionModeForFinding(finding) {
    if (!finding) return null;
    if (finding.agentAction?.mode) return finding.agentAction.mode;
    if (finding.semanticReview?.recommended) return "semantic-review";
    if (finding.stage === "S5" || finding.stage === "S4") return "staged-remediation";
    if (finding.stage === "S3") return "next-change-watch";
    return "observe-only";
  }

  function completeCall({ callId, toolEvent, result, callStartedAt, telemetryStartedAt }) {
    const telemetryQueueMs = Math.max(0, Date.now() - telemetryStartedAt);
    const toolMs = Math.max(0, Date.now() - callStartedAt);
    const phaseTimings = result?.monitoring?.phaseTimings;
    if (phaseTimings) {
      phaseTimings.toolHandlerMs = toolMs;
      phaseTimings.postAnalysisMs = Math.max(0, toolMs - (phaseTimings.policyMs || 0) - (phaseTimings.analysisMs || 0));
    }
    enqueueCallCompletedTelemetry({
      agent,
      projectId: result?.project?.id || null,
      repoId: result?.project?.repoId || null,
      projectInstanceId: result?.project?.projectInstanceId || result?.project?.id || null,
      sessionId,
      callId,
      scanId: result?.monitoring?.scanId || null,
      toolEvent,
      toolMs,
      telemetryQueueMs,
      result
    });
    syncCloudBestEffort();
  }

  server.registerTool("vibe_session_start", {
    description: "Start or resume Vibe Monitor for the current coding session. Can be interrupted or explicitly skipped without preventing coding. For an explicit user Skip request, set mode=skip. Otherwise establishes a bounded project assessment.",
    inputSchema: {
      path: pathSchema,
      mode: z.enum(["monitor", "skip"]).optional().describe("Set to skip ONLY if the user explicitly chose to skip Vibe Monitor for this request. Skip never grants scanning authorization or asserts project health.")
    }
  }, async ({ path, mode = "monitor" }, extra = {}) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    noticesShownThisSession = 0;
    const lifecycle = (event, reason = null) => {
      try {
        recordActivity(event, {
          agent, callId, localOnly: true,
          durationMs: Date.now() - callStartedAt,
          monitoringMode: reason || null,
          monitoringWallTimeMs: Date.now() - callStartedAt
        });
      } catch { /* Observability must never block coding or cancellation. */ }
    };
    lifecycle("call.started", mode);
    if (mode === "skip") {
      lifecycle("call.skipped", "user_skipped");
      return textResult(buildSkippedSessionPayload("user_skipped", callId, Date.now() - callStartedAt));
    }
    const controller = new AbortController();
    const onCancel = () => controller.abort("client_cancelled");
    extra.signal?.addEventListener("abort", onCancel, { once: true });
    if (extra.signal?.aborted) onCancel();
    activeSessionScans.add(controller);
    try {
      const { result, remotePolicy, disabled, disabledPayload } = await analyzeWithPolicy(path, {
        persist: true,
        kind: "session_start",
        forcePolicy: true,
        callId,
        interruptible: true,
        signal: controller.signal,
        onPhase: phase => lifecycle("call.phase", phase)
      });
      if (disabled) {
        lifecycle("call.unavailable", disabledPayload.monitoring?.mode || "disabled");
        return textResult(disabledPayload);
      }
      if (controller.signal.aborted) throw new ScanControlError("scan_cancelled");
      const telemetryStartedAt = Date.now();
      recordActivity("session_start", { agent, result, callId });
      const remaining = Math.max(
        0,
        remotePolicy.config.maxNoticesPerSession - noticesShownThisSession
      );
      const payload = buildAgentResult(result, {
        sessionStart: true,
        maxNotices: remaining,
        attentionFilter: finding => shouldSurfaceNotice(result.project.id, finding, {
          reminderMs: remotePolicy.config.unchangedNoticeReminderHours * 60 * 60 * 1000
        })
      });
      noticesShownThisSession += payload.attentionFindings.length;
      markSurfacedNotices(result.project.id, payload.attentionFindings);
      enqueueNoticeTelemetry({
        agent,
        projectId: result.project.id,
        repoId: result.project.repoId || null,
        projectInstanceId: result.project.projectInstanceId || result.project.id,
        sessionId,
        callId,
        scanId: result.monitoring?.scanId || null,
        surfacedFindings: payload.attentionFindings,
        suppressedCount: payload.suppressedAttentionCount,
        maxNotices: remaining
      });
      completeCall({
        callId,
        toolEvent: "session_start",
        result,
        callStartedAt,
        telemetryStartedAt
      });
      recordCallTiming(result, callStartedAt);
      lifecycle("call.finished", result.monitoring?.mode || "full");
      return textResult(payload);
    } catch (error) {
      const reason = error instanceof ScanControlError
        ? error.code === "scan_cancelled" && controller.signal.reason === "user_skipped"
          ? "user_skipped" : error.code
        : "scan_failed";
      lifecycle(reason === "user_skipped" ? "call.skipped" : reason === "scan_cancelled" ? "call.cancelled"
        : reason === "scan_timeout" ? "call.timeout" : "call.failed", reason);
      return textResult(buildSkippedSessionPayload(reason, callId, Date.now() - callStartedAt));
    } finally {
      activeSessionScans.delete(controller);
      extra.signal?.removeEventListener("abort", onCancel);
    }
  });


  server.registerTool("vibe_skip_current", {
    description: "Skip an in-progress Vibe Monitor Session Start, at the user's explicit request. Cancels active scanning in this MCP server without stopping coding or disabling future monitoring. Agent hosts may expose this tool as an action; Vibe Monitor cannot insert custom buttons in host UI.",
    inputSchema: {}
  }, async () => {
    const activeCount = activeSessionScans.size;
    for (const controller of activeSessionScans) controller.abort("user_skipped");
    return textResult({ skipped: activeCount > 0, activeCancelled: activeCount,
      nextAction: "Continue the coding task normally. Skipping Vibe Monitor does not authorize or complete a scan." });
  });

  server.registerTool("vibe_checkpoint", {
    description: "Checkpoint structural evolution after a meaningful implementation batch. Persists a snapshot and reports stage-aware findings.",
    inputSchema: { path: pathSchema }
  }, async ({ path }) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    const { result, remotePolicy, disabled, disabledPayload } = await analyzeWithPolicy(path, {
      persist: true,
      kind: "checkpoint",
      callId
    });
    if (disabled) return textResult(disabledPayload);
    const telemetryStartedAt = Date.now();
    recordActivity("checkpoint", { agent, result, callId });
    const remaining = Math.max(
      0,
      remotePolicy.config.maxNoticesPerSession - noticesShownThisSession
    );
    const payload = buildAgentResult(result, {
      maxNotices: remaining,
      attentionFilter: finding => shouldSurfaceNotice(result.project.id, finding, {
        reminderMs: remotePolicy.config.unchangedNoticeReminderHours * 60 * 60 * 1000
      })
    });
    noticesShownThisSession += payload.attentionFindings.length;
    markSurfacedNotices(result.project.id, payload.attentionFindings);
    enqueueNoticeTelemetry({
      agent,
      projectId: result.project.id,
      repoId: result.project.repoId || null,
      projectInstanceId: result.project.projectInstanceId || result.project.id,
      sessionId,
      callId,
      scanId: result.monitoring?.scanId || null,
      surfacedFindings: payload.attentionFindings,
      suppressedCount: payload.suppressedAttentionCount,
      maxNotices: remaining
    });
    completeCall({
      callId,
      toolEvent: "checkpoint",
      result,
      callStartedAt,
      telemetryStartedAt
    });
    recordCallTiming(result, callStartedAt);
    return textResult(payload);
  });

  server.registerTool("vibe_project_status", {
    description: "Read current architecture-evolution status without creating a history snapshot.",
    inputSchema: { path: pathSchema }
  }, async ({ path }) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    const { result, disabled, disabledPayload } = await analyzeWithPolicy(path, {
      persist: false,
      kind: "status",
      callId
    });
    if (disabled) return textResult(disabledPayload);
    const telemetryStartedAt = Date.now();
    recordActivity("project_status", { agent, result, callId });
    completeCall({
      callId,
      toolEvent: "project_status",
      result,
      callStartedAt,
      telemetryStartedAt
    });
    recordCallTiming(result, callStartedAt);
    return textResult(result);
  });

  server.registerTool("vibe_findings", {
    description: "Return current findings ordered by evolution stage and pressure score. Findings include Do now, Prepare, Do not do yet, and Next trigger.",
    inputSchema: { path: pathSchema }
  }, async ({ path }) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    const { result, disabled, disabledPayload } = await analyzeWithPolicy(path, {
      persist: false,
      kind: "findings",
      callId
    });
    if (disabled) return textResult(disabledPayload);
    const telemetryStartedAt = Date.now();
    recordActivity("findings", { agent, result, callId });
    completeCall({
      callId,
      toolEvent: "findings",
      result,
      callStartedAt,
      telemetryStartedAt
    });
    recordCallTiming(result, callStartedAt);
    return textResult({
      project: result.project, status: result.status, findings: result.findings,
      recommendationGroups: recommendationGroups(result.findings),
      highSeverityReviewQueue: highSeverityReviewQueue(result.findings, {limit: 10}),
      monitoring: { ...result.monitoring }
    });
  });

  // Explicit, read-only retirement inventory; never deletes user code or data.
  server.registerTool("vibe_legacy_audit", {
    description: "Find local legacy compatibility, retired feature markers, disabled branches and possibly unreferenced private functions. Each candidate requires consumer verification; nothing is auto-deleted.",
    inputSchema: { path: pathSchema }
  }, async ({ path }) => {
    const { result, disabled, disabledPayload } = await analyzeWithPolicy(path, {
      persist: false, kind: "legacy_audit"
    });
    if (disabled) return textResult(disabledPayload);
    const inventory = auditLegacyCode(result.project.root, {productIntent: result.productIntent});
    return textResult({project: result.project, capturedAt: new Date().toISOString(),
      ...inventory, telemetry: "local evidence only; no source excerpts sent to Cloud"});
  });

  server.registerTool("vibe_finding_intelligence", {
    description: "Read risk trend, evidence-review status and explicitly confirmed Product Intent guidance for one Finding. Includes an unverified baseline for future feedback, never causal attribution.",
    inputSchema: { id: z.string().max(100), path: pathSchema }
  }, async ({ id, path }) => {
    const { result, disabled, disabledPayload } = await analyzeWithPolicy(path, {
      persist: false, kind: "finding_intelligence"
    });
    if (disabled) return textResult(disabledPayload);
    const finding = result.findings.find(item => item.id === id);
    if (!finding) return textResult({ error: "finding_not_found", id });
    return textResult({
      findingId: finding.id, family: finding.family, stage: finding.stage,
      intelligence: finding.intelligence || null,
      assessmentAvailable: result.status?.assessmentAvailable !== false,
      limitations: "Risk change is observational. No action adoption or verified repair is inferred."
    });
  });

  server.registerTool("vibe_explain_finding", {
    description: "Explain one finding with evidence, standards mapping, heuristic disclosure, staged action and over-engineering guard.",
    inputSchema: {
      id: z.string().describe("Finding ID such as VM-ABC123"),
      path: pathSchema
    }
  }, async ({ id, path }) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    const { result, disabled, disabledPayload } = await analyzeWithPolicy(path, {
      persist: false,
      kind: "explain",
      callId
    });
    if (disabled) return textResult(disabledPayload);
    const finding = result.findings.find(f => f.id === id) || null;
    const telemetryStartedAt = Date.now();
    recordActivity("explain_finding", { agent, result, finding, callId });
    completeCall({
      callId,
      toolEvent: "explain_finding",
      result,
      callStartedAt,
      telemetryStartedAt
    });
    recordCallTiming(result, callStartedAt);
    return textResult(finding ? { ...findingDetail(result.project?.root || path || process.cwd(), finding, result.summary), monitoring: { ...result.monitoring } } : { error: "finding_not_found", id });
  });

  server.registerTool("vibe_product_intent", {
    description: "Read Vibe Monitor's current product-intent context. Inferred values are advisory; explicit values come only from the user's own stated intent.",
    inputSchema: { path: pathSchema }
  }, async ({ path }) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    const { result, disabled, disabledPayload } = await analyzeWithPolicy(path, {
      persist: false,
      kind: "intent",
      callId
    });
    if (disabled) return textResult(disabledPayload);
    const telemetryStartedAt = Date.now();
    recordActivity("product_intent", { agent, result, callId });
    completeCall({
      callId,
      toolEvent: "product_intent",
      result,
      callStartedAt,
      telemetryStartedAt
    });
    return textResult({ project: result.project, productIntent: result.productIntent });
  });

  server.registerTool("vibe_set_product_intent", {
    description: "Store explicit product-intent facts locally when the user has clearly stated them. Do not turn guesses into explicit intent and do not ask these questions unless an architecture decision materially depends on them.",
    inputSchema: {
      path: pathSchema,
      delivery: z.enum(["unknown", "local", "hosted", "hybrid"]).optional(),
      audience: z.enum(["unknown", "personal", "team", "public"]).optional(),
      tenancy: z.enum(["unknown", "single", "multi"]).optional(),
      criticality: z.enum(["unknown", "casual", "important", "critical"]).optional(),
      scale: z.enum(["unknown", "small", "growing", "large"]).optional(),
      dataSensitivity: z.enum(["unknown", "low", "standard", "sensitive"]).optional()
    }
  }, async ({ path, ...intentPatch }) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    const beforeState = await analyzeWithPolicy(path, {
      persist: false,
      kind: "intent",
      callId
    });
    if (beforeState.disabled) return textResult(beforeState.disabledPayload);
    const before = beforeState.result;
    saveExplicitIntent(before.project.id, intentPatch);
    const afterState = await analyzeWithPolicy(path, {
      persist: false,
      kind: "session_start",
      forcePolicy: false,
      callId
    });
    if (afterState.disabled) return textResult(afterState.disabledPayload);
    const result = afterState.result;
    const telemetryStartedAt = Date.now();
    recordActivity("product_intent_set", { agent, result, callId });
    completeCall({
      callId,
      toolEvent: "product_intent_set",
      result,
      callStartedAt,
      telemetryStartedAt
    });
    return textResult({ project: result.project, productIntent: result.productIntent });
  });

  server.registerTool("vibe_get_architecture_review_request", {
    description: "Create a bounded ARP v1 semantic architecture review request for a finding that explicitly recommends semantic review. The request contains normalized architecture evidence and no raw source code or project path.",
    inputSchema: {
      id: z.string().describe("Finding ID such as VM-ABC123"),
      path: pathSchema,
      independentReview: z.boolean().optional().describe("Request an independent agent review even when the evidence has already been reviewed")
    }
  }, async ({ id, path, independentReview = false }) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    const { result, disabled, disabledPayload } = await analyzeWithPolicy(path, {
      persist: false,
      kind: "architecture_review",
      callId
    });
    if (disabled) return textResult(disabledPayload);

    const finding = result.findings.find(item => item.id === id) || null;
    if (!finding) {
      return textResult({ error: "finding_not_found", id });
    }
    if (!finding.semanticReview?.recommended) {
      return textResult({
        reviewRequired: false,
        reason: "semantic_review_not_recommended",
        findingId: id,
        family: finding.family,
        stage: finding.stage,
        eligibilityEvidence: describeArchitectureReviewEligibility(finding, result)
      });
    }

    const request = buildArchitectureReviewRequest({
      result,
      finding,
      agent,
      sessionId
    });
    const reused = independentReview ? null : findReusableArchitectureReview(request);
    if (reused) {
      return textResult({
        reviewRequired: false,
        reason: "unchanged_evidence_previously_reviewed",
        previousReviewId: reused.reviewId,
        previousResponse: reused.response,
        respondedAt: reused.respondedAt
      });
    }
    persistArchitectureReviewRequest(request);
    const cloudPersistence = await createArchitectureReview(request);

    const telemetryStartedAt = Date.now();
    recordActivity("architecture_review_requested", {
      agent,
      result,
      finding,
      callId
    });
    completeCall({
      callId,
      toolEvent: "architecture_review_requested",
      result,
      callStartedAt,
      telemetryStartedAt
    });

    return textResult({
      reviewRequired: true,
      request,
      persistence: {
        localStored: true,
        cloudStored: cloudPersistence.stored === true,
        cloudReason: cloudPersistence.reason || null
      }
    });
  });

  server.registerTool("vibe_submit_architecture_review", {
    description: "Submit one ARP v1 semantic architecture review. Different agents may legitimately return different verdicts. Full model-generated review text stays local; Cloud receives only bounded structured review metadata for comparison and outcome learning.",
    inputSchema: {
      reviewId: z.string().uuid(),
      verdict: z.enum(["observe", "prepare", "intervene", "contain", "insufficient-evidence"]),
      recommendedStage: z.enum(["S1", "S2", "S3", "S4", "S5"]),
      confidence: z.number().min(0).max(1),
      summary: z.string().max(800).optional(),
      supportingEvidence: z.array(z.string().max(64)).max(24).optional(),
      counterEvidence: z.array(z.string().max(64)).max(24).optional(),
      assumptions: z.array(z.string().max(160)).max(12).optional(),
      doNow: z.array(z.string().max(160)).max(12).optional(),
      doNotDoYet: z.array(z.string().max(160)).max(12).optional(),
      nextTrigger: z.array(z.string().max(160)).max(12).optional(),
      decisionQuestions: z.array(z.string().max(160)).max(12).optional()
    }
  }, async ({
    reviewId,
    verdict,
    recommendedStage,
    confidence,
    summary,
    supportingEvidence,
    counterEvidence,
    assumptions,
    doNow,
    doNotDoYet,
    nextTrigger,
    decisionQuestions
  }) => {
    const access=await resolveDistributionPolicy({fetchPolicy:fetchRemotePolicy});
    if(access.enabled===false)return textResult(disabledPayload(access));
    const existing = loadArchitectureReview(reviewId);
    if (!existing?.request) {
      return textResult({ error: "review_request_not_found", reviewId });
    }

    const response = {
      protocolVersion: ARP_PROTOCOL_VERSION,
      reviewId,
      verdict,
      recommendedStage,
      confidence,
      summary: summary || "",
      supportingEvidence: supportingEvidence || [],
      counterEvidence: counterEvidence || [],
      assumptions: assumptions || [],
      doNow: doNow || [],
      doNotDoYet: doNotDoYet || [],
      nextTrigger: nextTrigger || [],
      decisionQuestions: decisionQuestions || []
    };

    let stored;
    try {
      stored = persistArchitectureReviewResponse(reviewId, response);
    } catch (error) {
      return textResult({
        error: error?.message || "review_response_invalid",
        reviewId
      });
    }

    const cloudPayload = cloudArchitectureReviewResponse(stored.response);
    const cloudPersistence = await submitArchitectureReviewResponse(
      reviewId,
      cloudPayload
    );

    return textResult({
      accepted: true,
      reviewId,
      verdict: stored.response.verdict,
      recommendedStage: stored.response.recommendedStage,
      confidence: stored.response.confidence,
      persistence: {
        localStored: true,
        cloudStored: cloudPersistence.stored === true,
        cloudReason: cloudPersistence.reason || null
      }
    });
  });

  // Outcome records stay local; only approved, bounded anonymous enum summaries may queue for Free telemetry.
  function outcomeProject(pathValue) {
    const identity = projectIdentity(findProjectRoot(projectContext.resolve(pathValue).path));
    return { identity, state: loadState(identity.id) };
  }

  server.registerTool("vibe_outcome_record_action", {
    description: "ONLY after a user or agent explicitly states they applied, deferred, or dismissed a specific Vibe recommendation. Record a REPORTED action, not inferred code changes; never claim a fix occurred. Idempotent via stable submissionId.",
    inputSchema: {
      path: pathSchema,
      id: z.string().max(100),
      disposition: z.enum(["applied", "deferred", "dismissed"]),
      actor: z.enum(["user", "agent"]),
      changeRef: z.string().regex(/^[a-f0-9]{7,64}$/i).optional(),
      submissionId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional()
    }
  }, async ({path, id, disposition, actor, changeRef, submissionId}) => {
    const remote = await resolveDistributionPolicy({fetchPolicy:fetchRemotePolicy});
    if (remote.enabled === false) return textResult(disabledPayload(remote));
    const {identity, state} = outcomeProject(path);
    if (!state.latest || state.findings?.evidenceVersion !== state.latest?.evidenceVersion)
      return textResult({error:"complete_comparable_baseline_required",next:"Run vibe_checkpoint"});
    const finding = state.findings?.items?.[id];
    if (!finding) return textResult({error:"finding_not_found_in_saved_snapshot",id});
    try {
      const record=recordOutcomeAction(identity.id,finding,{
        disposition,actor,changeRef:changeRef||null,submissionId:submissionId||null,
        evidenceVersion:state.latest.evidenceVersion
      });
      try{if(enqueueOutcomeTelemetry({kind:"action",projectId:identity.id,repoId:identity.repoId,
        projectInstanceId:identity.projectInstanceId,sessionId,agent,record,
        policyRevision:state.latest?.scoringPolicy?.revision}))syncCloudBestEffort();}catch{}
      return textResult({recorded:true,...record});
    } catch(error) {return textResult({recorded:false,error:error.message});}
  });

  server.registerTool("vibe_outcome_verify", {
    description: "Record ONLY explicit user-reported verification for a previously reported action. User affirmation plus regression-test/independent-review evidence type is still not proof of causation. Never fabricate execution or user confirmation.",
    inputSchema: {
      path: pathSchema,
      outcomeId: z.string().uuid(),
      verdict: z.enum(["confirmed","not_confirmed","inconclusive"]),
      evidenceType: z.enum(["regression_test","independent_review","manual_review"]),
      actor: z.enum(["user","agent"])
    }
  }, async ({path,outcomeId,verdict,evidenceType,actor}) => {
    const remote = await resolveDistributionPolicy({fetchPolicy:fetchRemotePolicy});
    if (remote.enabled === false) return textResult(disabledPayload(remote));
    const {identity,state} = outcomeProject(path);
    try {
      const record=recordOutcomeVerification(identity.id,outcomeId,{verdict,evidenceType,actor});
      try{if(enqueueOutcomeTelemetry({kind:"verification",projectId:identity.id,repoId:identity.repoId,
        projectInstanceId:identity.projectInstanceId,sessionId,agent,record,
        policyRevision:state.latest?.scoringPolicy?.revision}))syncCloudBestEffort();}catch{}
      return textResult({recorded:true,...record});
    }catch(error){return textResult({recorded:false,error:error.message});}
  });

  server.registerTool("vibe_outcome_status", {
    description: "Read local recommendation→reported action→comparable follow-up→user verification and recurrence history. No project scan or Cloud telemetry. Risk improvement is observational, attribution remains unproven.",
    inputSchema: {path:pathSchema, id:z.string().max(100).optional(),limit:z.number().int().min(1).max(100).optional()}
  }, async ({path,id,limit}) => {
    const remote = await resolveDistributionPolicy({fetchPolicy:fetchRemotePolicy});
    if (remote.enabled === false) return textResult(disabledPayload(remote));
    const {identity} = outcomeProject(path);
    return textResult(listOutcomeRecords(identity.id,{findingId:id||null,limit:limit||25}));
  });

  server.registerTool("vibe_feedback", {
    description: "Record explicit user feedback about a Vibe Monitor finding. Use only when the user clearly says a warning was useful, wrong, too early, too late, or confusing. Never ask for feedback after every warning.",
    inputSchema: {
      id: z.string().describe("Finding ID such as VM-ABC123"),
      verdict: z.enum(["useful", "false_positive", "too_early", "too_late", "confusing"]),
      note: z.string().max(500).optional().describe("Optional short user feedback. Stored locally."),
      path: pathSchema
    }
  }, async ({ id, verdict, note, path }) => {
    const callStartedAt = Date.now();
    const callId = crypto.randomUUID();
    // Feedback must never trigger a new project scan: a saved finding snapshot
    // is sufficient. Free uses the local policy; private Beta still respects
    // its normal remote service-control state.
    const remote=await resolveDistributionPolicy({fetchPolicy:fetchRemotePolicy});
    if(remote.enabled===false)return textResult(buildDisabledPolicyPayload(remote));
    const {identity,state}=outcomeProject(path);
    const finding=state.findings?.items?.[id]||null;
    const telemetryStartedAt=Date.now();
    const item=appendFeedback({
      agent,sessionId,callId,scanId:null,
      projectId:identity.id,repoId:identity.repoId||null,
      projectInstanceId:identity.projectInstanceId||identity.id,
      findingId:id,family:finding?.family||null,stage:finding?.stage||null,
      actionMode:actionModeForFinding(finding),verdict,note:note||null
    });
    // This is an interaction event, not a fabricated new architecture scan.
    try{
      enqueueCallCompletedTelemetry({agent,projectId:identity.id,repoId:identity.repoId,
        projectInstanceId:identity.projectInstanceId,sessionId,callId,scanId:null,
        toolEvent:"feedback",toolMs:Date.now()-callStartedAt,
        telemetryQueueMs:Date.now()-telemetryStartedAt,result:null});
      syncCloudBestEffort();
    }catch{}
    return textResult({
      recorded: true,
      verdict: item.verdict,
      findingId: item.findingId
    });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Resume persisted offline events without requiring a new tool call.
  freeTelemetryDrain?.request();
  scheduleAutomaticUpdate();
}
