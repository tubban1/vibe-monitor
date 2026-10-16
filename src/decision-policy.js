// Declarative scoring policy contract. No dynamic code, expressions, selectors,
// file paths, network destinations or remotely configurable privacy controls.
import crypto from "node:crypto";

export const POLICY_V2_SCHEMA_VERSION = 2;
export const POLICY_V2_FAMILIES = Object.freeze([
  "code-structure", "dependency-coupling", "platform-portability",
  "security-surface", "state-data", "async-concurrency",
  "reliability-recovery", "testing-verification", "observability",
  "distribution-scaling", "api-contract", "provider-integration", "ai-drift"
]);

const DEFAULT_THRESHOLDS = Object.freeze({ S2: 35, S3: 50, S4: 70, S5: 85 });
const DEFAULT_MIN_SIGNALS = Object.freeze({ S3: 3, S4: 4, S5: 4 });
const RANGES = Object.freeze({
  S2: [30, 45], S3: [45, 65], S4: [65, 85], S5: [80, 100]
});
export const LOCAL_SCORING_POLICY_KEY = "local-v1";

function plainObject(value) {
  return !!value && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function sanitizeDecisionPolicy(input) {
  if (!plainObject(input) || input.schemaVersion !== POLICY_V2_SCHEMA_VERSION) return null;
  const allowed = new Set(["schemaVersion","policyId","revision","stageThresholds","minSupportingSignals","familyScoreWeights"]);
  if (Object.keys(input).some(k => !allowed.has(k))) return null;
  if (typeof input.policyId !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(input.policyId)) return null;
  if (!boundedInteger(input.revision, 1, 1_000_000)) return null;
  const incoming = input.stageThresholds;
  const minInput = input.minSupportingSignals;
  const weightInput = input.familyScoreWeights ?? {};
  if (!plainObject(incoming) || !plainObject(minInput) || !plainObject(weightInput)) return null;
  if (Object.keys(incoming).some(k => !Object.hasOwn(DEFAULT_THRESHOLDS, k)) ||
      Object.keys(minInput).some(k => !Object.hasOwn(DEFAULT_MIN_SIGNALS, k)) ||
      Object.keys(weightInput).some(k => !POLICY_V2_FAMILIES.includes(k))) return null;

  const thresholds = {};
  for (const [stage, [low, high]] of Object.entries(RANGES)) {
    const n = incoming[stage];
    if (!boundedInteger(n, low, high)) return null;
    thresholds[stage] = n;
  }
  if (thresholds.S3 - thresholds.S2 < 8 ||
      thresholds.S4 - thresholds.S3 < 8 ||
      thresholds.S5 - thresholds.S4 < 8) return null;
  const minSupportingSignals = {};
  for (const [stage, fallback] of Object.entries(DEFAULT_MIN_SIGNALS)) {
    const n = minInput[stage];
    // The local anti-overengineering minimum is not remotely reducible.
    if (!boundedInteger(n, fallback, 8)) return null;
    minSupportingSignals[stage] = n;
  }
  const familyScoreWeights = {};
  for (const family of POLICY_V2_FAMILIES) {
    const n = weightInput[family] ?? 1;
    if (typeof n !== "number" || !Number.isFinite(n) ||
      n < 0.8 || n > 1.2) return null;
    familyScoreWeights[family] = Math.round(n * 100) / 100;
  }
  return Object.freeze({
    schemaVersion: 2, policyId: input.policyId, revision: input.revision,
    stageThresholds: Object.freeze(thresholds),
    minSupportingSignals: Object.freeze(minSupportingSignals),
    familyScoreWeights: Object.freeze(familyScoreWeights)
  });
}

// A signed remote Monitor mask is part of evidence comparability, never
// interchangeable with all-on history. Missing or all-on masks keep local-v1.
export function monitorPolicyFingerprint(enabledMonitors=null){
 const disabled=POLICY_V2_FAMILIES.filter(name=>enabledMonitors?.[name]===false);
 return disabled.length?":monitors-"+crypto.createHash("sha256").update(disabled.join("|")).digest("hex").slice(0,12):"";
}

export function scoringPolicyIdentity(decisionPolicy) {
  const p = sanitizeDecisionPolicy(decisionPolicy);
  if (!p) return { key: LOCAL_SCORING_POLICY_KEY, source: "local-default", schemaVersion: 1 };
  const hash = crypto.createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 16);
  return {
    key: "v2:" + p.policyId + ":" + p.revision + ":" + hash,
    policyId: p.policyId, revision: p.revision, schemaVersion: 2,
    digest: hash, source: "validated-policy-v2"
  };
}

export function evaluateScoringStage(score, supportingSignals, input, family) {
  const p = sanitizeDecisionPolicy(input);
  const thresholds = p?.stageThresholds ?? DEFAULT_THRESHOLDS;
  const minimum = p?.minSupportingSignals ?? DEFAULT_MIN_SIGNALS;
  const multiplier = p?.familyScoreWeights?.[family] ?? 1;
  const evaluatedScore = Math.max(0, Math.min(100, Math.round(score * multiplier * 100) / 100));
  let stage = evaluatedScore >= thresholds.S5 ? "S5" :
    evaluatedScore >= thresholds.S4 ? "S4" :
    evaluatedScore >= thresholds.S3 ? "S3" :
    evaluatedScore >= thresholds.S2 ? "S2" : "S1";
  const supporting = Number.isFinite(supportingSignals) ? supportingSignals : 0;
  if (supporting < minimum.S3 && ["S3","S4","S5"].includes(stage)) stage = "S2";
  if (supporting < minimum.S4 && ["S4","S5"].includes(stage)) stage = "S3";
  if (supporting < minimum.S5 && stage === "S5") stage = "S4";
  return stage;
}
