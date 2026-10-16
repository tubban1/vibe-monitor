// Pure policy normalization shared by public client and private Beta adapters.
// No Cloud I/O, token persistence, or telemetry side effects.
import {sanitizeDecisionPolicy} from "./decision-policy.js";

export const DEFAULT_POLICY = Object.freeze({
  checkpointMinIntervalSec: 180,
  fullScanMinIntervalSec: 300,
  maxNoticesPerSession: 2,
  unchangedNoticeReminderHours: 168,
  telemetrySampleRate: 1,
  configTtlSec: 1800,
  thresholdProfile: "beta",
  enabledMonitors: {
    "code-structure": true,
    "dependency-coupling": true,
    "platform-portability": true,
    "security-surface": true,
    "state-data": true,
    "async-concurrency": true,
    "reliability-recovery": true,
    "testing-verification": true,
    observability: true,
    "distribution-scaling": true,
    "api-contract": true,
    "provider-integration": true,
    "ai-drift": true
  }
});

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function sanitizeRemotePolicy(input = {}) {
  const enabledInput = input.enabledMonitors || {};
  const enabledMonitors = { ...DEFAULT_POLICY.enabledMonitors };
  for (const key of Object.keys(enabledMonitors)) {
    if (typeof enabledInput[key] === "boolean") enabledMonitors[key] = enabledInput[key];
  }

  return {
    checkpointMinIntervalSec: clampNumber(
      input.checkpointMinIntervalSec,
      0,
      3600,
      DEFAULT_POLICY.checkpointMinIntervalSec
    ),
    fullScanMinIntervalSec: clampNumber(
      input.fullScanMinIntervalSec,
      0,
      7200,
      DEFAULT_POLICY.fullScanMinIntervalSec
    ),
    maxNoticesPerSession: Math.trunc(
      clampNumber(input.maxNoticesPerSession, 0, 5, DEFAULT_POLICY.maxNoticesPerSession)
    ),
    unchangedNoticeReminderHours: clampNumber(
      input.unchangedNoticeReminderHours,
      1,
      24 * 90,
      DEFAULT_POLICY.unchangedNoticeReminderHours
    ),
    telemetrySampleRate: clampNumber(
      input.telemetrySampleRate,
      0,
      1,
      DEFAULT_POLICY.telemetrySampleRate
    ),
    configTtlSec: clampNumber(
      input.configTtlSec,
      60,
      24 * 3600,
      DEFAULT_POLICY.configTtlSec
    ),
    thresholdProfile: ["beta", "balanced", "quiet"].includes(input.thresholdProfile)
      ? input.thresholdProfile
      : DEFAULT_POLICY.thresholdProfile,
    enabledMonitors,
    decisionPolicy: sanitizeDecisionPolicy(input.decisionPolicy)
  };
}
