import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CLIENT_VERSION } from "./constants.js";
import { isOpenClientDistribution } from "./distribution.js";
import {
  cloudStatus,
  fetchRemotePolicy,
  sanitizeUpdatePolicy,
  updateEligibility
} from "./cloud.js";
import {
  ensureBundledNode,
  installRuntimeVersion,
  readRuntimePointer,
  runtimeVersionEntry,
  runtimeVersionRoot,
  writeRuntimePointer
} from "./install.js";
import { atomicJsonWrite, ensureDir, safeJsonRead, vibeHome } from "./utils.js";

const MAX_UPDATE_ARTIFACT_BYTES = 25 * 1024 * 1024;
const UPDATE_LOCK_STALE_MS = 30 * 60 * 1000;
let autoUpdateScheduled = false;

export function updatesRoot() {
  return path.join(vibeHome(), "updates");
}

export function updateStateFile() {
  return path.join(updatesRoot(), "state.json");
}

export function updateNoticeStateFile() {
  return path.join(updatesRoot(), "notice-state.json");
}

function updateLockFile(name) {
  return path.join(updatesRoot(), name + ".lock");
}

function acquireUpdateLock(name, { staleMs = UPDATE_LOCK_STALE_MS } = {}) {
  ensureDir(updatesRoot());
  const file = updateLockFile(name);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        }) + "\n", "utf8");
      } finally {
        fs.closeSync(fd);
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.rmSync(file, { force: true }); } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch {}
      throw new Error("update_" + name + "_in_progress");
    }
  }

  throw new Error("update_" + name + "_in_progress");
}

export function readUpdateState() {
  return safeJsonRead(updateStateFile(), {
    schemaVersion: 1,
    currentVersion: null,
    stagedVersion: null,
    stagedArtifactSha256: null,
    lastStagedVersion: null,
    activateOnNextStart: false,
    lastCheckAt: null,
    lastStageAt: null,
    lastActivationAttemptAt: null,
    lastRollbackAt: null,
    lastRollbackReason: null,
    lastFailureAt: null,
    lastFailureReason: null,
    quarantinedVersions: []
  });
}

function writeUpdateState(patch) {
  const current = readUpdateState();
  const next = {
    schemaVersion: 1,
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  atomicJsonWrite(updateStateFile(), next);
  return next;
}

function parseVersion(value) {
  const match = String(value || "").match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : []
  };
}

function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) === Number(b) ? 0 : (Number(a) > Number(b) ? 1 : -1);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a === b ? 0 : (a > b ? 1 : -1);
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error("invalid_update_version");

  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }

  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;

  const count = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < count; i++) {
    if (left.pre[i] == null) return -1;
    if (right.pre[i] == null) return 1;
    const compared = compareIdentifier(left.pre[i], right.pre[i]);
    if (compared) return compared;
  }
  return 0;
}

function currentRuntimeVersion() {
  return readRuntimePointer("current")?.version || CLIENT_VERSION;
}

function failureCode(error) {
  const value = String(error?.message || "update_failed");
  const known = [
    "update_not_enabled",
    "update_not_eligible",
    "update_version_missing",
    "update_artifact_missing",
    "update_artifact_too_large",
    "update_artifact_checksum_mismatch",
    "update_download_failed",
    "update_candidate_preflight_failed",
    "runtime_install_verification_failed",
    "runtime_npm_missing",
    "update_stage_in_progress",
    "update_activation_in_progress",
    "update_version_quarantined",
    "no_staged_update",
    "no_previous_runtime",
    "invalid_update_version"
  ];
  return known.find(code => value.startsWith(code)) || "update_failed";
}

async function fetchArtifact(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("update_download_failed:" + response.status);
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_UPDATE_ARTIFACT_BYTES) {
    throw new Error("update_artifact_too_large");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_UPDATE_ARTIFACT_BYTES) throw new Error("update_artifact_too_large");
  return bytes;
}

export async function updateStatus({ refresh = false } = {}) {
  // The public client has no signed artifact-release trust root yet. Never query
  // the legacy private-Beta update endpoint or advertise its candidates.
  if (isOpenClientDistribution()) return {
    currentVersion: currentRuntimeVersion(),
    previousVersion: readRuntimePointer("previous")?.version || null,
    stagedVersion: null,
    activateOnNextStart: false,
    channel: "unconfigured",
    updateEnabled: false,
    eligible: false,
    latestVersion: null,
    minimumVersion: null,
    available: false,
    belowMinimum: false,
    critical: false,
    autoStage: false,
    autoActivate: "manual",
    artifactReady: false,
    lastCheckAt: null,
    lastStageAt: null,
    lastRollbackAt: null,
    lastRollbackReason: null,
    lastFailureAt: null,
    lastFailureReason: null,
    quarantined: false,
    source: "open-client",
    reason: "signed_update_channel_not_configured"
  };
  const remote = await fetchRemotePolicy({ force: refresh });
  const cloud = cloudStatus();
  const rawUpdate = remote?.update || cloud.update || {};
  const update = sanitizeUpdatePolicy(rawUpdate);
  const eligible = rawUpdate?.eligible === true ||
    updateEligibility(update, cloud.installationId || null);
  const state = readUpdateState();
  const currentVersion = currentRuntimeVersion();
  const latestComparison = update.latestVersion
    ? compareVersions(update.latestVersion, currentVersion)
    : null;
  const minimumComparison = update.minimumVersion
    ? compareVersions(currentVersion, update.minimumVersion)
    : null;

  return {
    currentVersion,
    previousVersion: readRuntimePointer("previous")?.version || null,
    stagedVersion: state.stagedVersion || null,
    activateOnNextStart: state.activateOnNextStart === true,
    channel: update.channel,
    updateEnabled: update.enabled === true,
    eligible,
    latestVersion: update.latestVersion,
    minimumVersion: update.minimumVersion,
    available: update.enabled === true && eligible && latestComparison > 0,
    belowMinimum: minimumComparison != null && minimumComparison < 0,
    critical: update.critical === true,
    autoStage: update.autoStage === true,
    autoActivate: update.autoActivate,
    artifactReady: Boolean(update.artifact?.url && update.artifact?.sha256),
    lastCheckAt: state.lastCheckAt || null,
    lastStageAt: state.lastStageAt || null,
    lastRollbackAt: state.lastRollbackAt || null,
    lastRollbackReason: state.lastRollbackReason || null,
    lastFailureAt: state.lastFailureAt || null,
    lastFailureReason: state.lastFailureReason || null,
    quarantined: Boolean(
      update.latestVersion &&
      state.quarantinedVersions?.includes(update.latestVersion)
    ),
    source: remote?.source || null
  };
}

export async function stageUpdate({
  policy = null,
  force = false,
  nodeRuntime = null
} = {}) {
  // A checksum alone cannot authorize code execution: never accept a supplied
  // policy, legacy Beta token or update URL in the unsigned public client.
  if (isOpenClientDistribution()) throw new Error("signed_update_channel_not_configured");
  const remote = policy
    ? {
        source: "provided",
        update: {
          ...sanitizeUpdatePolicy(policy),
          eligible: policy?.eligible === true
        }
      }
    : await fetchRemotePolicy({ force: true });
  const rawUpdate = remote?.update || {};
  const update = sanitizeUpdatePolicy(rawUpdate);
  const cloud = cloudStatus();
  const eligible = rawUpdate?.eligible === true ||
    updateEligibility(update, cloud.installationId || null);
  const currentVersion = currentRuntimeVersion();
  const checkedAt = new Date().toISOString();

  writeUpdateState({ currentVersion, lastCheckAt: checkedAt });

  if (!update.enabled) throw new Error("update_not_enabled");
  if (!eligible && !force) throw new Error("update_not_eligible");
  if (!update.latestVersion) throw new Error("update_version_missing");
  if (!update.artifact?.url || !update.artifact?.sha256) throw new Error("update_artifact_missing");

  const relation = compareVersions(update.latestVersion, currentVersion);
  if (relation <= 0 && !force) {
    return {
      staged: false,
      reason: relation === 0 ? "already_current" : "downgrade_rejected",
      currentVersion,
      latestVersion: update.latestVersion
    };
  }

  const before = readUpdateState();
  const quarantined = new Set(before.quarantinedVersions || []);
  if (quarantined.has(update.latestVersion) && !force) {
    throw new Error("update_version_quarantined");
  }

  if (
    !force &&
    before.stagedVersion === update.latestVersion &&
    before.stagedArtifactSha256 === update.artifact.sha256 &&
    fs.existsSync(runtimeVersionEntry(update.latestVersion))
  ) {
    return {
      staged: true,
      reused: true,
      currentVersion,
      stagedVersion: update.latestVersion,
      artifactSha256: update.artifact.sha256,
      activateOnNextStart: before.activateOnNextStart === true,
      slot: runtimeVersionRoot(update.latestVersion)
    };
  }

  const releaseLock = acquireUpdateLock("stage");
  const stagingDir = path.join(updatesRoot(), "staging");
  let tempDir = null;

  try {
    ensureDir(stagingDir);
    tempDir = fs.mkdtempSync(path.join(stagingDir, "download-"));
    const artifactFile = path.join(tempDir, "vibe-monitor-" + update.latestVersion + ".tgz");

    const artifact = await fetchArtifact(update.artifact.url);
    const actualSha256 = crypto.createHash("sha256").update(artifact).digest("hex");
    if (actualSha256 !== update.artifact.sha256) {
      throw new Error("update_artifact_checksum_mismatch");
    }
    fs.writeFileSync(artifactFile, artifact, { mode: 0o600 });

    const runtime = nodeRuntime || await ensureBundledNode();
    const installed = await installRuntimeVersion({
      version: update.latestVersion,
      packageSpec: artifactFile,
      nodeRuntime: runtime,
      force: true
    });

    try {
      execFileSync(runtime.binary, [installed.entry, "doctor", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        env: { ...process.env, VIBE_MONITOR_UPDATE_PREFLIGHT: "1" }
      });
    } catch {
      throw new Error("update_candidate_preflight_failed");
    }

    const stagedAt = new Date().toISOString();
    const state = writeUpdateState({
      currentVersion,
      stagedVersion: update.latestVersion,
      stagedArtifactSha256: actualSha256,
      lastStagedVersion: update.latestVersion,
      stagedChannel: update.channel,
      stagedAt,
      lastStageAt: stagedAt,
      activateOnNextStart: update.autoActivate === "next-start",
      lastFailureAt: null,
      lastFailureReason: null,
      quarantinedVersions: (readUpdateState().quarantinedVersions || [])
        .filter(version => version !== update.latestVersion)
    });

    return {
      staged: true,
      reused: false,
      currentVersion,
      stagedVersion: update.latestVersion,
      artifactSha256: actualSha256,
      activateOnNextStart: state.activateOnNextStart,
      slot: runtimeVersionRoot(update.latestVersion)
    };
  } catch (error) {
    const code = failureCode(error);
    const state = readUpdateState();
    const nextQuarantined = new Set(state.quarantinedVersions || []);
    const quarantineCandidate = new Set([
      "update_artifact_too_large",
      "update_artifact_checksum_mismatch",
      "update_candidate_preflight_failed",
      "runtime_install_verification_failed"
    ]);
    if (update.latestVersion && quarantineCandidate.has(code)) {
      nextQuarantined.add(update.latestVersion);
    }

    writeUpdateState({
      currentVersion,
      lastFailureAt: new Date().toISOString(),
      lastFailureReason: code,
      activateOnNextStart: state.stagedVersion === update.latestVersion
        ? false
        : state.activateOnNextStart === true,
      quarantinedVersions: [...nextQuarantined].slice(-20)
    });
    throw error;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    releaseLock();
  }
}

function transientFailureBackoffActive(state, now = Date.now()) {
  const transient = new Set([
    "update_download_failed",
    "update_failed",
    "runtime_npm_missing"
  ]);
  if (!transient.has(state?.lastFailureReason)) return false;
  const at = Date.parse(state?.lastFailureAt || "");
  return Number.isFinite(at) && now - at < 5 * 60 * 1000;
}

export function observeAvailableUpdate(rawUpdate = {}) {
  if (isOpenClientDistribution()) return false;
  const update = sanitizeUpdatePolicy(rawUpdate);
  const cloud = cloudStatus();
  const eligible = rawUpdate?.eligible === true || updateEligibility(update, cloud.installationId || null);
  const available = update.enabled === true && eligible && Boolean(update.latestVersion) &&
    compareVersions(update.latestVersion, currentRuntimeVersion()) > 0;
  const state = readUpdateState();
  if (available && state.availableVersion !== update.latestVersion) {
    writeUpdateState({ availableVersion: update.latestVersion, availableDetectedAt: new Date().toISOString() });
  } else if (!available && state.availableVersion) {
    writeUpdateState({ availableVersion: null, availableDetectedAt: null });
  }
  return available;
}

export function consumeUpdateNotice() {
  if (isOpenClientDistribution()) return null;
  const state = readUpdateState();
  const candidates = [];

  if (state.availableVersion && state.availableDetectedAt && compareVersions(state.availableVersion, currentRuntimeVersion()) > 0) {
    candidates.push({
      type: "update_available",
      version: state.availableVersion,
      at: state.availableDetectedAt,
      message: "Vibe Monitor " + state.availableVersion +
        " is available. The current runtime remains active until an update is verified and activated."
    });
  }

  if (state.lastStageAt && state.stagedVersion && state.activateOnNextStart === true) {
    candidates.push({
      type: "update_staged",
      version: state.stagedVersion,
      at: state.lastStageAt,
      message: "Vibe Monitor " + state.stagedVersion +
        " is staged and will activate the next time the coding agent restarts."
    });
  }

  if (state.lastFailureAt && state.lastFailureReason) {
    candidates.push({
      type: "update_failed",
      version: state.lastStagedVersion || state.stagedVersion || null,
      reason: state.lastFailureReason,
      at: state.lastFailureAt,
      message: "Vibe Monitor could not stage an update (" + state.lastFailureReason +
        "). The current verified runtime remains active."
    });
  }

  if (state.lastRollbackAt && state.lastRollbackReason) {
    candidates.push({
      type: "update_rolled_back",
      version: state.currentVersion || null,
      reason: state.lastRollbackReason,
      at: state.lastRollbackAt,
      message: "Vibe Monitor rolled back to the previous verified runtime after an update problem."
    });
  }

  candidates.sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""));
  const candidate = candidates[0] || null;
  if (!candidate) return null;

  const fingerprint = [
    candidate.type,
    candidate.version || "",
    candidate.reason || "",
    candidate.at || ""
  ].join(":");
  const prior = safeJsonRead(updateNoticeStateFile(), {});
  if (prior.lastFingerprint === fingerprint) return null;

  atomicJsonWrite(updateNoticeStateFile(), {
    schemaVersion: 1,
    lastFingerprint: fingerprint,
    lastType: candidate.type,
    lastVersion: candidate.version || null,
    surfacedAt: new Date().toISOString()
  });
  return candidate;
}

export function scheduleAutomaticUpdate({ delayMs = 2500 } = {}) {
  if (isOpenClientDistribution()) return false;
  if (autoUpdateScheduled || process.env.VIBE_MONITOR_UPDATE_PREFLIGHT === "1") return false;

  const current = readRuntimePointer("current");
  if (!current || !["version", "legacy"].includes(current.type)) return false;

  autoUpdateScheduled = true;
  const timer = setTimeout(async () => {
    try {
      const status = await updateStatus({ refresh: false });
      observeAvailableUpdate((await fetchRemotePolicy({ force: false }))?.update || {});
      const state = readUpdateState();
      if (
        !status.updateEnabled ||
        !status.eligible ||
        !status.available ||
        !status.autoStage ||
        !status.artifactReady ||
        state.quarantinedVersions?.includes(status.latestVersion) ||
        transientFailureBackoffActive(state)
      ) {
        return;
      }
      await stageUpdate();
    } catch (error) {
      const code = failureCode(error);
      if (code === "update_stage_in_progress" || code === "update_version_quarantined") return;
    }
  }, Math.max(0, delayMs));
  timer.unref?.();
  return true;
}

export function activateStagedUpdate() {
  if (isOpenClientDistribution()) throw new Error("signed_update_channel_not_configured");
  const state = readUpdateState();
  if (!state.stagedVersion) throw new Error("no_staged_update");
  return writeUpdateState({
    activateOnNextStart: true,
    activationRequestedAt: new Date().toISOString()
  });
}

export function rollbackUpdate() {
  if (isOpenClientDistribution()) throw new Error("signed_update_channel_not_configured");
  const releaseLock = acquireUpdateLock("activation");
  try {
    const current = readRuntimePointer("current");
    const previous = readRuntimePointer("previous");
    if (!previous) throw new Error("no_previous_runtime");

    writeRuntimePointer("current", previous);
    if (current) writeRuntimePointer("previous", current);

    return writeUpdateState({
      currentVersion: previous.version || null,
      stagedVersion: null,
      stagedArtifactSha256: null,
      activateOnNextStart: false,
      lastRollbackAt: new Date().toISOString(),
      lastRollbackReason: "manual"
    });
  } finally {
    releaseLock();
  }
}
