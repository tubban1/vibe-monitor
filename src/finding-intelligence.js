import { sha256 } from "./utils.js";

const RANK = Object.freeze({S1:1,S2:2,S3:3,S4:4,S5:5});
const HIGH_IMPACT = new Set(["code-structure","dependency-coupling","distribution-scaling","api-contract","security-surface","state-data","async-concurrency"]);

function confirmedIntent(intent, key) {
  const value = intent?.explicit?.[key];
  // Inferred information must never authorize a high-impact architecture action.
  return intent?.source?.[key] === "explicit" || (
    !intent?.source && value && value !== "unknown"
  ) ? value : null;
}

function reviewAssessment(finding) {
  const severe = (RANK[finding.stage] || 0) >= 4;
  const confidence = Number.isFinite(finding.confidence) ? finding.confidence : null;
  const structural = Boolean(finding.structuralEvidence?.boundaryCandidateCount > 0);
  const direct = /direct|structural/.test(String(finding.evidenceQuality || ""));
  const independentSignals = new Set((finding.signals || [])
    .filter(s => s.active !== false)
    .map(s => s.independenceGroup || s.name)
    .filter(Boolean)).size;
  // No rule score is calibrated against human-labelled ground truth yet.
  const requiresReview = severe;
  const reason = severe
    ? (!direct || independentSignals < 3 || confidence === null || confidence < 0.75)
      ? "high_stage_limited_evidence"
      : "high_stage_requires_independent_confirmation"
    : "not_high_stage";
  return { requiresReview, reason, calibration: "uncalibrated",
    confidence, directEvidence: direct, structuralBoundaryCandidate: structural,
    independentSignalGroups: independentSignals };
}

function contextualAdvice(finding, productIntent) {
  const {family} = finding;
  const tenancy = confirmedIntent(productIntent,"tenancy");
  const sensitivity = confirmedIntent(productIntent,"dataSensitivity");
  const criticality = confirmedIntent(productIntent,"criticality");
  const audience = confirmedIntent(productIntent,"audience");
  const delivery = confirmedIntent(productIntent,"delivery");
  const scale = confirmedIntent(productIntent,"scale");
  if (tenancy === "multi" && ["security-surface","state-data","api-contract"].includes(family))
    return {code:"verify_tenant_boundaries", provenance:"explicit",
      advice:"Confirm tenant authorization and data separation before modifying shared routes or persistence."};
  if (sensitivity === "sensitive" && ["security-surface","observability","state-data"].includes(family))
    return {code:"verify_sensitive_data_boundaries",provenance:"explicit",
      advice:"Verify data access, log redaction and retention before changing this boundary."};
  if (criticality === "critical" && ["reliability-recovery","testing-verification","async-concurrency"].includes(family))
    return {code:"verify_critical_recovery",provenance:"explicit",
      advice:"Require focused recovery and regression tests before applying the smallest safe change."};
  if ((audience === "personal" || scale === "small" || delivery === "local") &&
      ["code-structure","distribution-scaling","dependency-coupling"].includes(family))
    return {code:"avoid_premature_distribution",provenance:"explicit",
      advice:"Keep local module boundaries simple; do not introduce services without independent operational need."};
  if (HIGH_IMPACT.has(family) && (RANK[finding.stage] || 0) >= 4 &&
    ![tenancy,sensitivity,criticality,audience,delivery,scale].some(Boolean))
    return {code:"confirm_product_intent",provenance:"unknown",
      advice:"Confirm relevant product intent before making an irreversible architecture decision."};
  return {code:"context_not_required",provenance:"none",advice:null};
}

/** Advisory assessment. The Finding's stable ID, severity and detection evidence never change here. */
export function enrichFindingIntelligence(finding, previous = null, productIntent = null, capturedAt = null, {persist = true} = {}) {
  const old = previous?.id === finding.id && previous.family === finding.family ? previous : null;
  const firstSeenAt = old?.intelligence?.firstSeenAt || capturedAt;
  const oldCount = Number.isSafeInteger(old?.intelligence?.observedScans)
    ? old.intelligence.observedScans : old ? 1 : 0;
  const previousScore = Number.isFinite(old?.score) ? old.score : null;
  const scoreDelta = previousScore === null || !Number.isFinite(finding.score)
    ? null : Number((finding.score - previousScore).toFixed(2));
  const previousRank = RANK[old?.stage] || 0;
  const rank = RANK[finding.stage] || 0;
  const trend = !old ? "new" : rank > previousRank ? "worsened" :
    rank < previousRank ? "improved_observed" :
    scoreDelta !== null && scoreDelta >= 10 ? "pressure_rising" :
    scoreDelta !== null && scoreDelta <= -10 ? "pressure_falling" : "stable";
  const severityReview = reviewAssessment(finding);
  const context = contextualAdvice(finding, productIntent);
  const decision = rank <= 2 ? "observe" :
    severityReview.requiresReview ? "verify_before_refactor" : "prepare_small_change";
  const priority = rank * 10 + (trend === "worsened" ? 12 : trend === "pressure_rising" ? 5 : 0);
  return {
    ...finding,
    intelligence: {
      schemaVersion: 1,
      stableFindingId: finding.id,
      firstSeenAt,
      observedScans: Math.min(oldCount + (persist ? 1 : 0), 1000000),
      previousStage: old?.stage || null,
      previousScore,
      scoreDelta,
      trend,
      severityReview,
      intentContext: context,
      decision,
      priority,
      outcomeBaseline: {
        protocolVersion: 1,
        anchorId: sha256(JSON.stringify([
          finding.id,finding.stage,Number.isFinite(finding.score)?finding.score:null,capturedAt
        ])).slice(0,24),
        capturedAt,
        findingId: finding.id,
        stage: finding.stage,
        score: Number.isFinite(finding.score) ? finding.score : null,
        attribution: "unproven",
        verifiedAction: false
      }
    }
  };
}

/** Intentionally does NOT infer repairs from source changes or a disappeared ID. */
export function compareFindingOutcome(baseline, followUp, { completeScan = false, confirmedAction = false } = {}) {
  if (!baseline?.findingId || !baseline.anchorId) throw Error("invalid_outcome_baseline");
  if (!completeScan) return {status:"insufficient_evidence",attribution:"unproven",repairConfirmed:false};
  if (!followUp || followUp.id !== baseline.findingId)
    return {status:"finding_unobserved",attribution:"unproven",repairConfirmed:false};
  const before=RANK[baseline.stage] || 0,after=RANK[followUp.stage] || 0;
  const status=after<before?"risk_improved_observed":after>before?"risk_worsened_observed":"risk_not_improved";
  // Even when an action is explicitly confirmed, correlation is not causation.
  return {status,attribution:confirmedAction?"action_reported_not_causal":"unproven",
    repairConfirmed:false};
}

/** Human review worklist, not automatic certification of S4/S5. */
export function highSeverityReviewQueue(findings = [], { limit = 10 } = {}) {
  return findings
    .filter(f => ["S4", "S5"].includes(f.stage))
    .sort((a,b) => {
      const limitedA = a.intelligence?.severityReview?.reason === "high_stage_limited_evidence" ? 1 : 0;
      const limitedB = b.intelligence?.severityReview?.reason === "high_stage_limited_evidence" ? 1 : 0;
      return limitedB-limitedA || (RANK[b.stage]||0)-(RANK[a.stage]||0) ||
        (a.confidence ?? 0)-(b.confidence ?? 0);
    })
    .slice(0, Math.max(0, Math.min(25, Number.isInteger(limit) ? limit : 10)))
    .map(f => ({
      findingId:f.id, family:f.family, stage:f.stage,
      reviewRequired:true,
      evidenceReview:f.intelligence?.severityReview || reviewAssessment(f),
      suggestedVerification:"Check supporting evidence and counterexamples before confirming severity or refactoring.",
      confirmation:"pending_user_or_independent_review"
    }));
}
