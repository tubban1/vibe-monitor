import fs from "node:fs";
import path from "node:path";
import { atomicJsonWrite, safeJsonRead } from "./utils.js";
import { decryptJson } from "./secure-store.js";
import { projectStateDir } from "./history.js";

export const INTENT_FIELDS = Object.freeze({
  delivery: ["unknown", "local", "hosted", "hybrid"],
  audience: ["unknown", "personal", "team", "public"],
  tenancy: ["unknown", "single", "multi"],
  criticality: ["unknown", "casual", "important", "critical"],
  scale: ["unknown", "small", "growing", "large"],
  dataSensitivity: ["unknown", "low", "standard", "sensitive"]
});

function intentJsonFile(projectId) {
  return path.join(projectStateDir(projectId), "intent.json");
}

function intentEncryptedFile(projectId) {
  return path.join(projectStateDir(projectId), "intent.enc");
}

function migrateEncryptedIntent(projectId) {
  const json = intentJsonFile(projectId);
  const enc = intentEncryptedFile(projectId);
  if (!fs.existsSync(enc)) return;
  if (fs.existsSync(json)) {
    try {
      JSON.parse(fs.readFileSync(json, "utf8"));
      try { fs.chmodSync(json, 0o600); } catch {}
      fs.unlinkSync(enc);
      return;
    } catch {
      // Recover from the encrypted legacy copy below.
    }
  }
  try {
    const envelope = JSON.parse(fs.readFileSync(enc, "utf8"));
    atomicJsonWrite(json, decryptJson(envelope, enc));
    fs.unlinkSync(enc);
  } catch {}
}

export function loadExplicitIntent(projectId) {
  migrateEncryptedIntent(projectId);
  return safeJsonRead(intentJsonFile(projectId), null)?.values || {};
}

export function saveExplicitIntent(projectId, patch) {
  const current = loadExplicitIntent(projectId);
  const next = { ...current };

  for (const [key, value] of Object.entries(patch || {})) {
    const allowed = INTENT_FIELDS[key];
    if (!allowed) continue;
    if (!allowed.includes(value)) throw new Error("invalid_intent_" + key);
    if (value === "unknown") delete next[key];
    else next[key] = value;
  }

  atomicJsonWrite(intentJsonFile(projectId), {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    values: next
  });
  try { fs.unlinkSync(intentEncryptedFile(projectId)); } catch {}
  return next;
}

export function intentRevision(projectId) {
  for (const file of [intentJsonFile(projectId), intentEncryptedFile(projectId)]) {
    try {
      const stat = fs.statSync(file);
      return String(Math.trunc(stat.mtimeMs)) + ":" + stat.size;
    } catch {}
  }
  return "none";
}

export function inferProductIntent(scan) {
  const summary = scan?.summary || {};
  const hostedEvidence =
    (summary.deploymentTargetCount || 0) +
    ((summary.publicEndpoints || 0) >= 5 ? 2 : 0);
  const localEvidence =
    ((summary.processSignals || 0) >= 3 ? 1 : 0) +
    ((summary.platformAssumptions || 0) >= 4 ? 1 : 0);
  const multiUserEvidence =
    ((summary.tenantSignals || 0) >= 3 ? 2 : 0) +
    ((summary.commercialSignals || 0) >= 2 ? 1 : 0);

  let delivery = "unknown";
  if (hostedEvidence >= 2 && localEvidence >= 2) delivery = "hybrid";
  else if (hostedEvidence >= 2) delivery = "hosted";
  else if (localEvidence >= 2 && (summary.publicEndpoints || 0) < 3) delivery = "local";

  let audience = "unknown";
  if (multiUserEvidence >= 2) audience = "public";

  const tenancy = (summary.tenantSignals || 0) >= 3 ? "multi" : "unknown";
  const commercial = (summary.commercialSignals || 0) >= 2 ? "likely" : "unknown";

  const evidence = [];
  if (summary.deploymentTargetCount) evidence.push("deployment targets are present");
  if ((summary.publicEndpoints || 0) >= 5) evidence.push("the project exposes multiple request endpoints");
  if ((summary.tenantSignals || 0) >= 3) evidence.push("multi-user or tenant concepts are present");
  if ((summary.commercialSignals || 0) >= 2) evidence.push("billing/payment concepts are present");
  if ((summary.processSignals || 0) >= 3) evidence.push("the project controls local processes/workers");
  if ((summary.platformAssumptions || 0) >= 4) evidence.push("the project has platform-specific runtime behavior");

  return {
    delivery,
    audience,
    tenancy,
    commercial,
    confidence: Math.min(0.85, 0.35 + evidence.length * 0.1),
    evidence: evidence.slice(0, 5)
  };
}

export function resolveProductIntent(projectId, scan) {
  const explicit = loadExplicitIntent(projectId);
  const inferred = inferProductIntent(scan);
  const effective = {
    // Inferred intent is useful context, but it is not a user-confirmed fact
    // and must not authorize a high-impact architecture recommendation.
    delivery: explicit.delivery || "unknown",
    audience: explicit.audience || "unknown",
    tenancy: explicit.tenancy || "unknown",
    criticality: explicit.criticality || "unknown",
    scale: explicit.scale || "unknown",
    dataSensitivity: explicit.dataSensitivity || "unknown"
  };
  const source = Object.fromEntries(Object.keys(INTENT_FIELDS).map(key => [
    key,
    explicit[key] ? "explicit" : inferred[key] && inferred[key] !== "unknown" ? "inferred" : "unknown"
  ]));
  source.commercial = inferred.commercial && inferred.commercial !== "unknown" ? "inferred" : "unknown";

  return {
    explicit,
    inferred,
    effective,
    source,
    missingForHighImpactDecisions: [
      effective.scale === "unknown" ? "scale" : null,
      effective.criticality === "unknown" ? "criticality" : null
    ].filter(Boolean)
  };
}
