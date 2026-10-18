import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getOrCreateSecret } from "./secure-store.js";
import { atomicJsonWrite, ensureDir, safeJsonRead, vibeHome } from "./utils.js";

export const ARP_PROTOCOL_VERSION = 1;

export const REVIEW_VERDICTS = Object.freeze([
  "observe",
  "prepare",
  "intervene",
  "contain",
  "insufficient-evidence"
]);

const STAGES = ["S1", "S2", "S3", "S4", "S5"];

const shortString = z.string().min(1).max(160);
const evidenceRef = z.string().min(1).max(64);

export const architectureReviewResponseSchema = z.object({
  protocolVersion: z.literal(ARP_PROTOCOL_VERSION).default(ARP_PROTOCOL_VERSION),
  reviewId: z.string().uuid(),
  verdict: z.enum(REVIEW_VERDICTS),
  recommendedStage: z.enum(STAGES),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(800).optional().default(""),
  supportingEvidence: z.array(evidenceRef).max(24).default([]),
  counterEvidence: z.array(evidenceRef).max(24).default([]),
  assumptions: z.array(shortString).max(12).default([]),
  doNow: z.array(shortString).max(12).default([]),
  doNotDoYet: z.array(shortString).max(12).default([]),
  nextTrigger: z.array(shortString).max(12).default([]),
  decisionQuestions: z.array(shortString).max(12).default([])
}).strict();

let hmacSecretCache = null;

function hmacSecret() {
  if (!hmacSecretCache) hmacSecretCache = getOrCreateSecret("telemetry-hmac-secret", 32);
  return hmacSecretCache;
}

export function architectureReviewPseudonym(value) {
  if (!value) return null;
  return crypto
    .createHmac("sha256", hmacSecret())
    .update(String(value))
    .digest("hex")
    .slice(0, 32);
}

function reviewsRoot() {
  return ensureDir(path.join(vibeHome(), "reviews"));
}

function reviewFile(reviewId) {
  return path.join(reviewsRoot(), reviewId + ".json");
}

function finiteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function boundedSignals(finding) {
  return (finding?.signals || [])
    .filter(signal => signal?.active !== false && typeof signal?.name === "string")
    .slice(0, 24)
    .map(signal => ({
      key: signal.name.slice(0, 64),
      bucket: typeof signal.bucket === "string" ? signal.bucket.slice(0, 32) : null,
      independenceGroup: typeof signal.independenceGroup === "string"
        ? signal.independenceGroup.slice(0, 48)
        : null,
      value: typeof signal.value === "number" && Number.isFinite(signal.value)
        ? signal.value
        : null
    }));
}

function safeProductIntent(productIntent) {
  const effective = productIntent?.effective || {};
  const pick = value => typeof value === "string" ? value.slice(0, 32) : "unknown";
  return {
    delivery: pick(effective.delivery),
    audience: pick(effective.audience),
    tenancy: pick(effective.tenancy),
    criticality: pick(effective.criticality),
    scale: pick(effective.scale),
    dataSensitivity: pick(effective.dataSensitivity),
    missingForHighImpactDecisions: Array.isArray(productIntent?.missingForHighImpactDecisions)
      ? productIntent.missingForHighImpactDecisions
          .filter(value => typeof value === "string")
          .slice(0, 8)
          .map(value => value.slice(0, 48))
      : []
  };
}

function transitionContext(result, findingId) {
  const transition = (result?.transitions || []).find(change => change?.id === findingId);
  if (!transition) return null;
  return {
    type: typeof transition.type === "string" ? transition.type.slice(0, 32) : null,
    fromStage: STAGES.includes(transition.fromStage) ? transition.fromStage : null,
    toStage: STAGES.includes(transition.toStage) ? transition.toStage : null
  };
}

function structuralEvidence(finding) {
  const structural = finding?.semanticReview?.evidence || {};
  const out = {};
  for (const key of [
    "functionCount",
    "responsibilityClusterCount",
    "localCallEdges",
    "boundaryCandidateCount"
  ]) {
    const value = finiteNumber(structural[key]);
    if (value != null) out[key] = value;
  }
  return out;
}

function evidenceKeys(request) {
  const keys = new Set();
  for (const signal of request?.evidence?.signals || []) {
    if (signal?.key) keys.add(signal.key);
  }
  for (const key of Object.keys(request?.evidence?.structural || {})) keys.add("structural." + key);
  return keys;
}

export function describeArchitectureReviewEligibility(finding, result = {}) {
  const structural = finding?.structuralEvidence || null;
  const clusterCount = Number.isFinite(structural?.responsibilityClusterCount)
    ? structural.responsibilityClusterCount : null;
  const boundaryCount = Number.isFinite(structural?.boundaryCandidateCount)
    ? structural.boundaryCandidateCount : null;
  const stage = STAGES.includes(finding?.stage) ? finding.stage : null;
  const eligible = finding?.semanticReview?.recommended === true;

  const qualification = eligible
    ? "semantic_review_recommended"
    : !["S3", "S4", "S5"].includes(stage)
      ? "below_semantic_review_stage"
      : !structural
        ? "no_current_review_recommendation"
        : boundaryCount > 0
          ? "structural_boundary_candidate_available"
          : clusterCount !== null && clusterCount < 2
            ? "fewer_than_two_structural_responsibility_clusters"
            : "no_current_review_recommendation";

  return {
    eligible,
    qualification,
    evidenceVersion: result?.evidenceVersion ?? null,
    evidenceCapturedAt: result?.capturedAt ?? null,
    scanMode: result?.monitoring?.mode || "unknown",
    structuralAnalyzed: Boolean(structural),
    responsibilityClusterCount: clusterCount,
    boundaryCandidateCount: boundaryCount,
    boundaryAssessment: finding?.boundaryAssessment?.status || null,
    note: "ARP eligibility depends on evidence in this scan, not on S-stage alone. Cached results may differ from a later full scan."
  };
}

export function buildArchitectureReviewRequest({
  result,
  finding,
  agent = "unknown",
  sessionId = null,
  reviewId = crypto.randomUUID()
} = {}) {
  if (!finding) throw new Error("review_finding_required");
  if (!finding.semanticReview?.recommended) throw new Error("semantic_review_not_recommended");
  if (!result?.project?.id) throw new Error("review_project_required");

  const signals = boundedSignals(finding);
  const supportingGroups = new Set(
    signals.map(signal => signal.independenceGroup).filter(Boolean)
  );

  const reviewQuestions = Array.isArray(finding.semanticReview?.questions)
    ? finding.semanticReview.questions
        .filter(value => typeof value === "string")
        .slice(0, 5)
        .map(value => value.slice(0, 320))
    : [];

  const request = {
    protocolVersion: ARP_PROTOCOL_VERSION,
    reviewId,
    createdAt: new Date().toISOString(),
    agent: typeof agent === "string" ? agent.slice(0, 40) : "unknown",
    sessionId: typeof sessionId === "string" ? sessionId : null,
    project: {
      repoId: architectureReviewPseudonym(result.project.repoId || result.project.id),
      projectInstanceId: architectureReviewPseudonym(
        result.project.projectInstanceId || result.project.id
      )
    },
    finding: {
      findingId: architectureReviewPseudonym(finding.id),
      family: String(finding.family || "unknown").slice(0, 64),
      candidateStage: STAGES.includes(finding.stage) ? finding.stage : "S1",
      candidateConfidence: finiteNumber(finding.confidence),
      evidenceQuality: typeof finding.evidenceQuality === "string"
        ? finding.evidenceQuality.slice(0, 96)
        : null
    },
    question: {
      type: finding.family === "code-structure"
        ? "boundary-decision"
        : "architecture-decision",
      text: "Does the current evidence justify an architecture intervention now, or should the project continue with observation or preparation?",
      reviewQuestions
    },
    productIntent: safeProductIntent(result.productIntent),
    evidence: {
      score: finiteNumber(finding.score),
      confidence: finiteNumber(finding.confidence),
      supportingSignalCount: supportingGroups.size,
      signals,
      structural: structuralEvidence(finding)
    },
    history: {
      snapshotCount: Math.max(0, Number(result?.history?.snapshotCount || 0)),
      currentTransition: transitionContext(result, finding.id)
    },
    constraints: [
      "Prefer the smallest sufficient intervention.",
      "Separate current evidence from speculation.",
      "State what should not be done yet.",
      "Do not recommend a service/distributed boundary from size alone.",
      "Identify missing information that could materially change the verdict."
    ],
    requiredOutput: {
      verdict: REVIEW_VERDICTS,
      recommendedStage: STAGES,
      confidenceRange: [0, 1],
      fields: [
        "summary",
        "supportingEvidence",
        "counterEvidence",
        "assumptions",
        "doNow",
        "doNotDoYet",
        "nextTrigger",
        "decisionQuestions"
      ]
    }
  };

  request.evidenceDigest = crypto
    .createHash("sha256")
    .update(JSON.stringify({
      finding: request.finding,
      question: request.question,
      productIntent: request.productIntent,
      evidence: request.evidence,
      history: request.history,
      constraints: request.constraints
    }))
    .digest("hex");

  return request;
}

export function persistArchitectureReviewRequest(request) {
  const record = {
    schemaVersion: 1,
    status: "requested",
    request,
    response: null,
    updatedAt: new Date().toISOString()
  };
  atomicJsonWrite(reviewFile(request.reviewId), record);
  return record;
}

export function loadArchitectureReview(reviewId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(reviewId || ""))) return null;
  return safeJsonRead(reviewFile(reviewId), null);
}

/** Reuse an unchanged review across agent sessions; new evidence always creates a new review. */
export function findReusableArchitectureReview(request) {
  if (!request?.evidenceDigest || !request?.project?.projectInstanceId || !request?.finding?.findingId) return null;
  let names;
  try { names = fs.readdirSync(reviewsRoot()); } catch { return null; }
  for (const name of names.filter(n => /^[0-9a-f-]{36}\.json$/i.test(n))) {
    const record = safeJsonRead(path.join(reviewsRoot(), name), null);
    const previous = record?.request;
    if (record?.status !== "responded" || !record?.response) continue;
    if (previous?.project?.projectInstanceId !== request.project.projectInstanceId ||
        previous?.finding?.findingId !== request.finding.findingId ||
        previous?.evidenceDigest !== request.evidenceDigest) continue;
    return { reviewId: previous.reviewId, response: record.response, respondedAt: record.respondedAt };
  }
  return null;
}

export function validateArchitectureReviewResponse(input, request = null) {
  const parsed = architectureReviewResponseSchema.parse(input);
  if (request && parsed.reviewId !== request.reviewId) {
    throw new Error("review_id_mismatch");
  }

  if (request) {
    const allowedEvidence = evidenceKeys(request);
    const unknown = [
      ...parsed.supportingEvidence,
      ...parsed.counterEvidence
    ].filter(ref => !allowedEvidence.has(ref));
    if (unknown.length) {
      throw new Error("review_evidence_reference_unknown:" + unknown[0]);
    }
  }

  return parsed;
}

export function persistArchitectureReviewResponse(reviewId, response) {
  const existing = loadArchitectureReview(reviewId);
  if (!existing?.request) throw new Error("review_request_not_found");
  const validated = validateArchitectureReviewResponse(response, existing.request);
  const record = {
    ...existing,
    status: "responded",
    response: validated,
    respondedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  atomicJsonWrite(reviewFile(reviewId), record);
  return record;
}

export function cloudArchitectureReviewResponse(response) {
  return {
    protocolVersion: ARP_PROTOCOL_VERSION,
    reviewId: response.reviewId,
    verdict: response.verdict,
    recommendedStage: response.recommendedStage,
    confidence: response.confidence,
    supportingEvidence: response.supportingEvidence,
    counterEvidence: response.counterEvidence,
    counts: {
      assumptions: response.assumptions.length,
      doNow: response.doNow.length,
      doNotDoYet: response.doNotDoYet.length,
      nextTrigger: response.nextTrigger.length,
      decisionQuestions: response.decisionQuestions.length
    }
  };
}

export function removeArchitectureReviewForTest(reviewId) {
  try { fs.rmSync(reviewFile(reviewId), { force: true }); } catch {}
}
