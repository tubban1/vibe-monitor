// Declarative scoring policy contract. No dynamic code, expressions, selectors,
// file paths, network destinations or remotely configurable privacy controls.
//
// Normative / external baseline:
//   Alert system flap detection (e.g. Nagios flap detection, Prometheus
//   alert stabilization with 'for' / 'keep_firing_for'), and classical
//   hysteresis in control engineering (Schmitt trigger).
// Vibe Monitor derived model:
//   Stage demotion hysteresis — separating the promotion threshold from
//   the demotion threshold for findings already at Sk (k >= 3).
// Heuristic:
//   DEFAULT_DEMOTION_MARGIN = 5 (allowed range 0-15). This buffer margin
//   is a tunable engineering parameter, not a standardized requirement.
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
export const DEFAULT_DEMOTION_MARGIN = 5;
const RANGES = Object.freeze({
  S2: [30, 45], S3: [45, 65], S4: [65, 85], S5: [80, 100]
});
export const LOCAL_SCORING_POLICY_KEY = "local-minimal-v2";

function plainObject(value) {
  return !!value && typeof value === "object" &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function boundedInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function sanitizeDecisionPolicy(input) {
  if (!plainObject(input) || input.schemaVersion !== POLICY_V2_SCHEMA_VERSION) return null;
  const allowed = new Set(["schemaVersion","policyId","revision","stageThresholds","minSupportingSignals","familyScoreWeights","signalWeights","adviceRules","demotionMargin"]);
  if (Object.keys(input).some(k => !allowed.has(k))) return null;
  if (typeof input.policyId !== "string" || !/^[a-z][a-z0-9-]{2,63}$/.test(input.policyId)) return null;
  if (!boundedInteger(input.revision, 1, 1_000_000)) return null;
  const incoming = input.stageThresholds;
  const minInput = input.minSupportingSignals;
  const weightInput = input.familyScoreWeights ?? {};
  const weightsIn = input.signalWeights ?? {}, guidanceIn = input.adviceRules ?? {};
  if (!plainObject(weightsIn) || !plainObject(guidanceIn)) return null;
  if (Object.keys(weightsIn).some(f => !POLICY_V2_FAMILIES.includes(f)) ||
      Object.keys(guidanceIn).some(f => !POLICY_V2_FAMILIES.includes(f))) return null;
  const signalWeights = {}, adviceRules = {};
  for (const [family, weights] of Object.entries(weightsIn)) {
    if (!plainObject(weights) || Object.keys(weights).length > 24) return null;
    for (const [name, n] of Object.entries(weights))
      if (!/^[a-z][a-z0-9_]{1,63}$/.test(name) ||
          !boundedInteger(n, 0, 45)) return null;
    signalWeights[family] = Object.freeze({...weights});
  }
  for (const [family, guidance] of Object.entries(guidanceIn)) {
    if (!plainObject(guidance) ||
        Object.keys(guidance).some(k => !["doNow","prepare","doNotDoYet","nextTrigger","whyItMatters"].includes(k))) return null;
    const checked = {};
    for (const k of Object.keys(guidance)) {
      const a = ["nextTrigger","whyItMatters"].includes(k) ? [guidance[k]] : guidance[k];
      if (!Array.isArray(a) || a.length > 4 ||
          a.some(t => typeof t !== "string" || t.length < 1 || t.length > 300 || /[\x00-\x1f]/.test(t))) return null;
      checked[k] = ["nextTrigger","whyItMatters"].includes(k) ? a[0] : Object.freeze([...a]);
    }
    adviceRules[family] = Object.freeze(checked);
  }
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
  const demotionMargin = boundedInteger(input.demotionMargin, 0, 15)
    ? input.demotionMargin
    : DEFAULT_DEMOTION_MARGIN;

  return Object.freeze({
    schemaVersion: 2, policyId: input.policyId, revision: input.revision,
    stageThresholds: Object.freeze(thresholds),
    minSupportingSignals: Object.freeze(minSupportingSignals),
    familyScoreWeights: Object.freeze(familyScoreWeights),
    signalWeights: Object.freeze(signalWeights), adviceRules: Object.freeze(adviceRules),
    demotionMargin
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

export function resolveDemotionMargin(input) {
  if (!input) return DEFAULT_DEMOTION_MARGIN;
  if (boundedInteger(input.demotionMargin, 0, 15)) return input.demotionMargin;
  const p = sanitizeDecisionPolicy(input);
  if (p && boundedInteger(p.demotionMargin, 0, 15)) return p.demotionMargin;
  return DEFAULT_DEMOTION_MARGIN;
}

export function evaluateScoringStage(score, supportingSignals, input, family, previousStage = null) {
  const p = sanitizeDecisionPolicy(input);
  const thresholds = p?.stageThresholds ?? DEFAULT_THRESHOLDS;
  const minimum = p?.minSupportingSignals ?? DEFAULT_MIN_SIGNALS;
  const multiplier = p?.familyScoreWeights?.[family] ?? 1;
  const margin = resolveDemotionMargin(p ?? input);
  const evaluatedScore = Math.max(0, Math.min(100, Math.round(score * multiplier * 100) / 100));
  const supporting = Number.isFinite(supportingSignals) ? supportingSignals : 0;

  // Hysteresis buffer applies when a finding is already at Sk (k >= 3).
  // 1. Promotion (upgrade) rules remain unchanged: must reach normal Sk threshold and meet min signals.
  // 2. Demotion buffer: finding already at Sk requires score < (Sk threshold - demotionMargin) to demote,
  //    OR if supporting signals fall below that stage's minimum, it demotes immediately.
  const prevRank = ["S1", "S2", "S3", "S4", "S5"].indexOf(previousStage) + 1;

  const s5Threshold = prevRank >= 5 ? thresholds.S5 - margin : thresholds.S5;
  const s4Threshold = prevRank >= 4 ? thresholds.S4 - margin : thresholds.S4;
  const s3Threshold = prevRank >= 3 ? thresholds.S3 - margin : thresholds.S3;

  let stage = (evaluatedScore >= s5Threshold && supporting >= minimum.S5) ? "S5" :
    (evaluatedScore >= s4Threshold && supporting >= minimum.S4) ? "S4" :
    (evaluatedScore >= s3Threshold && supporting >= minimum.S3) ? "S3" :
    evaluatedScore >= thresholds.S2 ? "S2" : "S1";

  return stage;
}


// Signed data-only scoring. No executable Cloud expressions and no access
// to source content, filesystem, or network from the policy interpreter.
export function scoreFromSignedSignals(signals, policy, family, fallback) {
  const weights = sanitizeDecisionPolicy(policy)?.signalWeights?.[family];
  if (!weights || !Object.keys(weights).length) return fallback;
  let score = 0;
  const seen = new Set();
  for (const {name, active} of signals || []) {
    if (!active || seen.has(name)) continue;
    seen.add(name);
    score += weights[name] ?? 0;
  }
  return Math.max(0, Math.min(100, score));
}
export function signedAdviceForFamily(policy, family) {
  return sanitizeDecisionPolicy(policy)?.adviceRules?.[family] ?? null;
}
