import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectStateDir } from "./history.js";
import { atomicJsonWrite } from "./utils.js";

const MAX_RECORDS = 120;
const MAX_OBSERVATIONS = 16;
const RANK = { S1: 1, S2: 2, S3: 3, S4: 4, S5: 5 };
const DISPOSITIONS = new Set(["applied", "deferred", "dismissed"]);
const ACTORS = new Set(["user", "agent"]);
const VERDICTS = new Set(["confirmed", "not_confirmed", "inconclusive"]);
const EVIDENCE_TYPES = new Set(["regression_test", "independent_review", "manual_review"]);
function outcomeFile(id) { return path.join(projectStateDir(id), "outcomes.json"); }
function read(id) {
  const file = outcomeFile(id);
  if (!fs.existsSync(file)) return {schemaVersion:1, records:[]};
  let data;
  try { data = JSON.parse(fs.readFileSync(file,"utf8")); }
  catch { throw Error("outcome_state_corrupt"); }
  if (data?.schemaVersion !== 1 || !Array.isArray(data.records))
    throw Error("outcome_state_unsupported");
  return {schemaVersion: 1, records: data.records.slice(-MAX_RECORDS)};
}
function mutate(id, action) {
  const file = outcomeFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + ".lock";
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let acquired = false;
  for (let i = 0; i < 50; i++) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); acquired = true; break; }
    catch (e) {
      if (e?.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 120000) fs.rmSync(lock, { recursive: true, force: true }); } catch {}
      Atomics.wait(sleeper, 0, 0, 4);
    }
  }
  if (!acquired) throw Error("outcome_state_busy");
  try {
    const state = read(id);
    const result = action(state);
    if (result.changed) {
      state.records = state.records.slice(-MAX_RECORDS);
      atomicJsonWrite(file, state);
    }
    return result.value;
  } finally { try { fs.rmdirSync(lock); } catch {} }
}
function statusOf(r) {
  if (r.action.disposition !== "applied") return "not_applied";
  const observations = r.observations || [];
  const comparable = observations.filter(o => o.kind === "observed");
  const rank = RANK[r.baseline.stage] || 0;
  // Latest incompatible or absent evidence suspends an earlier positive verdict.
  const latest = observations.at(-1);
  if (latest?.kind === "not_comparable") return "not_comparable";
  if (latest?.kind === "unobserved") return "finding_unobserved_needs_review";
  const firstImprovedIndex = comparable.findIndex(o => RANK[o.stage] < rank);
  const recurrence = firstImprovedIndex >= 0 && comparable.slice(firstImprovedIndex+1).some(o => RANK[o.stage] >= rank);
  if (recurrence) return "recurrence_observed";
  if (firstImprovedIndex >= 0 && r.verification?.verdict === "confirmed" &&
      r.verification.actor === "user" && r.verification.evidenceType !== "manual_review")
    return "user_confirmed_with_observed_improvement";
  if (r.verification?.verdict === "not_confirmed") return "verification_not_confirmed";
  if (firstImprovedIndex >= 0) return "risk_improvement_observed";
  if (!observations.length) return "waiting_followup";
  if (comparable.some(o => RANK[o.stage] > rank)) return "risk_worsened_observed";
  return "no_improvement_observed";
}
function present(r) {
  return {...r, status: statusOf(r), attribution: "unproven", repairCausalityConfirmed: false};
}
export function recordOutcomeAction(id, finding, {disposition, actor, evidenceVersion, at = new Date().toISOString(), changeRef = null, submissionId = null} = {}) {
  if (!DISPOSITIONS.has(disposition) || !ACTORS.has(actor)) throw Error("invalid_outcome_action");
  if (!finding?.id || !finding.intelligence?.outcomeBaseline?.anchorId || !evidenceVersion)
    throw Error("missing_outcome_baseline");
  if (changeRef !== null && !/^[a-f0-9]{7,64}$/i.test(changeRef)) throw Error("invalid_change_reference");
  if (submissionId !== null && !/^[A-Za-z0-9_-]{8,80}$/.test(submissionId))
    throw Error("invalid_outcome_submission_id");
  return mutate(id, state => {
    const existing = submissionId && state.records.find(r => r.submissionId === submissionId);
    if (existing) {
      if (existing.findingId !== finding.id || existing.action.disposition !== disposition ||
          existing.action.actor !== actor || existing.action.changeRef !== changeRef)
        throw Error("outcome_submission_conflict");
      return {changed:false,value:present(existing)};
    }
    const baseline = finding.intelligence.outcomeBaseline;
    const record = {
      outcomeId: crypto.randomUUID(), submissionId, findingId: finding.id, family: finding.family,
      baseline: {anchorId: baseline.anchorId, capturedAt: baseline.capturedAt,
        stage: finding.stage, score: Number.isFinite(finding.score) ? finding.score : null,
        evidenceVersion},
      action: {disposition, actor, reportedAt: at, changeRef},
      observations: [], verification: null
    };
    state.records.push(record);
    return {changed: true, value: present(record)};
  });
}
export function observeOutcomeCheckpoint(id, {capturedAt, evidenceVersion, findings, fingerprint = null} = {}) {
  if (!fs.existsSync(outcomeFile(id)) || !capturedAt || !evidenceVersion || !Array.isArray(findings)) return 0;
  return mutate(id, state => {
    let changed = 0;
    const current = new Map(findings.map(f => [f.id, f]));
    for (const r of state.records) {
      if (r.action.disposition !== "applied" || Date.parse(capturedAt) <= Date.parse(r.action.reportedAt)) continue;
      const seen = r.observations ||= [];
      if (seen.some(o => o.capturedAt === capturedAt || (fingerprint && o.fingerprint === fingerprint))) continue;
      let next;
      if (evidenceVersion !== r.baseline.evidenceVersion) next = {kind: "not_comparable"};
      else {
        const f = current.get(r.findingId);
        next = f ? {kind: "observed", stage: f.stage, score: Number.isFinite(f.score) ? f.score : null}
          : {kind: "unobserved"};
      }
      seen.push({...next, capturedAt, fingerprint: fingerprint || null});
      if (seen.length > MAX_OBSERVATIONS) seen.splice(0, seen.length - MAX_OBSERVATIONS);
      changed++;
    }
    return {changed: changed > 0, value: changed};
  });
}
export function recordOutcomeVerification(id, outcomeId, {verdict, evidenceType, actor} = {}) {
  if (!VERDICTS.has(verdict) || !EVIDENCE_TYPES.has(evidenceType) || !ACTORS.has(actor))
    throw Error("invalid_outcome_verification");
  if (verdict === "confirmed" && actor !== "user") throw Error("user_confirmation_required");
  return mutate(id, state => {
    const record = state.records.find(r => r.outcomeId === outcomeId);
    if (!record) throw Error("outcome_not_found");
    if (record.action.disposition !== "applied") throw Error("outcome_action_not_applied");
    record.verification = {verdict, evidenceType, actor, reportedAt: new Date().toISOString()};
    return {changed: true, value: present(record)};
  });
}
export function listOutcomeRecords(id, {limit = 25, findingId = null} = {}) {
  const records = read(id).records.filter(r => !findingId || r.findingId === findingId)
    .slice(-Math.max(1,Math.min(100,limit))).reverse().map(present);
  return {schemaVersion: 1, records, summary: {
    trackedActions: records.length,
    reportedApplied: records.filter(r => r.action.disposition === "applied").length,
    observedImproved: records.filter(r => ["risk_improvement_observed", "user_confirmed_with_observed_improvement"].includes(r.status)).length,
    userConfirmed: records.filter(r => r.status === "user_confirmed_with_observed_improvement").length,
    recurrenceObserved: records.filter(r => r.status === "recurrence_observed").length
  }, metricsScope:"locally reported actions in this response, not all users or findings"};
}
