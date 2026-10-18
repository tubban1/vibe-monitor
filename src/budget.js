import crypto from "node:crypto";
import path from "node:path";
import { analyzeProject, readCachedAnalysis } from "./engine.js";
import { scoringPolicyIdentity,monitorPolicyFingerprint } from "./decision-policy.js";
import { ScanBudgetExceededError } from "./scanner.js";
import { findProjectRoot, projectChangeFingerprint, projectIdentity } from "./project.js";
import { intentRevision } from "./intent.js";

export function createMonitoringBudgetSession({ scanLimits = null } = {}) {
  const startedAt = Date.now();
  const memory = new Map();
  const rootCache = new Map();
  const identityCache = new Map();
  let fullScanCount = 0;
  let cachedCheckCount = 0;
  let deferredCheckCount = 0;
  let cumulativeScanMs = 0;

  function withMonitoring(result, mode, wallTimeMs, scanId, extra = {}) {
    const sessionElapsedMs = Math.max(0, Date.now() - startedAt);
    const scannerOverheadPct = Number(
      ((cumulativeScanMs / Math.max(sessionElapsedMs, 60_000)) * 100).toFixed(2)
    );
    const { phaseTimings: extraPhaseTimings = {}, ...extraFields } = extra;
    return {
      ...result,
      monitoring: {
        mode,
        scanId,
        wallTimeMs,
        fullScanCount,
        cachedCheckCount,
        deferredCheckCount,
        cumulativeScanMs,
        sessionElapsedMs,
        scannerOverheadPct,
        targetOverheadPct: 3,
        ...extraFields,
        phaseTimings: {
          ...(mode === "full" ? (result.phaseTimings || {}) : {}),
          ...extraPhaseTimings
        }
      }
    };
  }

  function cachedResult(entry) {
    return { ...entry.result, transitions: [], durationMs: 0 };
  }

  function analyze(
    inputPath = process.cwd(),
    { persist = true, kind = "checkpoint", policy = {} } = {}
  ) {
    const started = Date.now();
    const scanId = crypto.randomUUID();
    const now = Date.now();

    const inputKey = path.resolve(inputPath);

    const rootStartedAt = Date.now();
    let root = rootCache.get(inputKey);
    let rootMs = 0;
    if (!root) {
      root = findProjectRoot(inputPath);
      rootCache.set(inputKey, root);
      rootMs = Date.now() - rootStartedAt;
    }

    const identityStartedAt = Date.now();
    let identity = identityCache.get(root);
    let identityMs = 0;
    if (!identity) {
      identity = projectIdentity(root);
      identityCache.set(root, identity);
      identityMs = Date.now() - identityStartedAt;
    }

    const fingerprintStartedAt = Date.now();
    const projectFingerprint = projectChangeFingerprint(root);
    const gitFingerprintMs = Date.now() - fingerprintStartedAt;

    const intentRevisionStartedAt = Date.now();
    const revision = intentRevision(identity.id);
    const intentRevisionMs = Date.now() - intentRevisionStartedAt;

    const decisionPolicy = policy.decisionPolicy || null;
    const policyKey = scoringPolicyIdentity(decisionPolicy).key+monitorPolicyFingerprint(policy.enabledMonitors);
    const fingerprint = projectFingerprint
      ? projectFingerprint + ":" + revision + (policyKey === "local-minimal-v2" ? "" : ":" + policyKey)
      : null;
    // Never reuse a cached assessment from a different scoring policy.
    const previouslyCached = memory.get(root);
    const memoryCached = (previouslyCached?.result?.scoringPolicy?.key || "local-minimal-v2") === policyKey
      ? previouslyCached : null;

    if (
      identityCache.has(root) &&
      memoryCached?.projectFingerprint &&
      projectFingerprint &&
      memoryCached.projectFingerprint !== projectFingerprint
    ) {
      const refreshStartedAt = Date.now();
      identity = projectIdentity(root);
      identityCache.set(root, identity);
      identityMs += Date.now() - refreshStartedAt;
    }
    const preflightPhaseTimings = {
      rootMs,
      identityMs,
      gitFingerprintMs,
      intentRevisionMs,
      budgetPreflightMs: Date.now() - started
    };

    const checkpointMinMs = Math.max(
      0,
      Number(policy.checkpointMinIntervalSec || 0) * 1000
    );
    const fullScanMinMs = Math.max(
      0,
      Number(policy.fullScanMinIntervalSec || 0) * 1000
    );

    if (fingerprint && memoryCached?.fingerprint === fingerprint) {
      if (memoryCached.blockedUntil && now < memoryCached.blockedUntil) {
        deferredCheckCount += 1;
        return withMonitoring(cachedResult(memoryCached), "deferred",
          Date.now() - started, scanId, {
            projectChanged: true,
            assessmentAvailable: false,
            evidenceIncomplete: true,
            deferReason: "evidence_budget_exceeded",
            nextEligibleInSec: Math.ceil((memoryCached.blockedUntil - now) / 1000),
            phaseTimings: preflightPhaseTimings
          });
      }
      if (!memoryCached.blockedUntil) {
      cachedCheckCount += 1;
      memoryCached.lastCheckAt = now;
      return withMonitoring(
        cachedResult(memoryCached),
        "cached",
        Date.now() - started,
        scanId,
        {
          projectChanged: false,
          phaseTimings: preflightPhaseTimings
        }
      );
      }
    }

    if (memoryCached && kind !== "session_start" && !memoryCached.blockedUntil) {
      const sinceCheck = now - (memoryCached.lastCheckAt || 0);
      if (checkpointMinMs > 0 && sinceCheck < checkpointMinMs) {
        deferredCheckCount += 1;
        return withMonitoring(
          cachedResult(memoryCached),
          "deferred",
          Date.now() - started,
          scanId,
          {
            projectChanged: fingerprint !== memoryCached.fingerprint,
            deferReason: "checkpoint_interval",
            nextEligibleInSec: Math.ceil((checkpointMinMs - sinceCheck) / 1000),
            phaseTimings: preflightPhaseTimings
          }
        );
      }

      const sinceFull = now - (memoryCached.lastFullScanAt || 0);
      if (
        fingerprint &&
        fingerprint !== memoryCached.fingerprint &&
        fullScanMinMs > 0 &&
        sinceFull < fullScanMinMs
      ) {
        deferredCheckCount += 1;
        memoryCached.lastCheckAt = now;
        return withMonitoring(
          cachedResult(memoryCached),
          "deferred",
          Date.now() - started,
          scanId,
          {
            projectChanged: true,
            deferReason: "full_scan_interval",
            nextEligibleInSec: Math.ceil((fullScanMinMs - sinceFull) / 1000),
            phaseTimings: preflightPhaseTimings
          }
        );
      }
    }

    const cacheStartedAt = Date.now();
    const diskCached = readCachedAnalysis(root, fingerprint, {
      projectRoot: root,
      identity,
      decisionPolicy,
      enabledMonitors:policy.enabledMonitors
    });
    const cacheReadMs = Date.now() - cacheStartedAt;
    if (diskCached) {
      cachedCheckCount += 1;
      const capturedAt = Date.parse(diskCached.capturedAt || "");
      memory.set(root, {
        fingerprint,
        projectFingerprint,
        result: diskCached,
        lastCheckAt: now,
        lastFullScanAt: Number.isFinite(capturedAt) ? capturedAt : now
      });
      return withMonitoring(
        diskCached,
        "cached",
        Date.now() - started,
        scanId,
        {
          projectChanged: false,
          phaseTimings: {
            ...preflightPhaseTimings,
            cacheReadMs
          }
        }
      );
    }

    let result;
    try {
      result = analyzeProject(root, {
        persist,
        changeFingerprint: fingerprint,
        projectRoot: root,
        identity,
        scanLimits,
        decisionPolicy,
        enabledMonitors:policy.enabledMonitors
      });
    } catch (error) {
      if (!(error instanceof ScanBudgetExceededError)) throw error;
      // The scanner must not persist or score incomplete evidence.
      deferredCheckCount += 1;
      const prior = memoryCached ? cachedResult(memoryCached) : {
        schemaVersion: 1,
        project: {
          id: identity.id,
          repoId: identity.repoId,
          projectInstanceId: identity.projectInstanceId,
          root
        },
        capturedAt: null,
        durationMs: 0,
        status: {},
        findings: [],
        transitions: []
      };
      const safeResult = {
        ...prior,
        transitions: [],
        // Previous findings, if any, are retained only as stale context.
        status: {
          ...prior.status,
          assessmentAvailable: false,
          highestStage: "unknown",
          findingCount: null,
          attentionCount: null,
          attentionRequired: false
        }
      };
      memory.set(root, {
        fingerprint, projectFingerprint, result: safeResult, lastCheckAt: now,
        blockedUntil: now + 60_000
      });
      return withMonitoring(safeResult, "deferred", Date.now() - started, scanId, {
        projectChanged: true,
        evidenceIncomplete: true,
        assessmentAvailable: false,
        deferReason: "evidence_budget_exceeded",
        budgetPhase: error.phase,
        // A prior snapshot remains evidence of its capture date, not today's state.
        snapshotAgeMs: prior.capturedAt ? Math.max(0, Date.now() - Date.parse(prior.capturedAt)) : null,
        phaseTimings: { ...preflightPhaseTimings, cacheReadMs }
      });
    }
    fullScanCount += 1;
    cumulativeScanMs += result.durationMs || 0;
    memory.set(root, {
      fingerprint,
      projectFingerprint,
      result,
      lastCheckAt: now,
      lastFullScanAt: now
    });
    return withMonitoring(
      result,
      "full",
      Date.now() - started,
      scanId,
      {
        projectChanged: Boolean(memoryCached && fingerprint !== memoryCached.fingerprint),
        phaseTimings: {
          ...preflightPhaseTimings,
          cacheReadMs
        }
      }
    );
  }

  return {
    analyze,
    stats() {
      return {
        fullScanCount,
        cachedCheckCount,
        deferredCheckCount,
        cumulativeScanMs,
        sessionElapsedMs: Math.max(0, Date.now() - startedAt)
      };
    }
  };
}
