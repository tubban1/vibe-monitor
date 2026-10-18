import fs from "node:fs";
import path from "node:path";
import { atomicJsonWrite, ensureDir, safeJsonRead, vibeHome } from "./utils.js";
import { decryptJson } from "./secure-store.js";
import { recordProjectMetadata } from "./projects.js";

export function projectStateDir(projectId) {
  return path.join(vibeHome(), "projects", projectId);
}

function migrateOneEncrypted(encryptedFile, jsonFile) {
  if (!fs.existsSync(encryptedFile)) return false;
  if (fs.existsSync(jsonFile)) {
    try {
      JSON.parse(fs.readFileSync(jsonFile, "utf8"));
      try { fs.chmodSync(jsonFile, 0o600); } catch {}
      fs.unlinkSync(encryptedFile);
      return false;
    } catch {
      // Recover from the encrypted legacy copy below.
    }
  }
  try {
    const envelope = JSON.parse(fs.readFileSync(encryptedFile, "utf8"));
    const value = decryptJson(envelope, encryptedFile);
    atomicJsonWrite(jsonFile, value);
    fs.unlinkSync(encryptedFile);
    return true;
  } catch {
    return false;
  }
}

export function loadState(projectId) {
  const dir = projectStateDir(projectId);
  migrateOneEncrypted(path.join(dir, "latest.enc"), path.join(dir, "latest.json"));
  migrateOneEncrypted(path.join(dir, "findings.enc"), path.join(dir, "findings.json"));
  return {
    latest: safeJsonRead(path.join(dir, "latest.json"), null),
    findings: safeJsonRead(path.join(dir, "findings.json"), { items: {} }),
    dir
  };
}

export function saveSnapshot(projectId, snapshot, findings) {
  const dir = ensureDir(projectStateDir(projectId));
  const snapshotsDir = ensureDir(path.join(dir, "snapshots"));
  const stamp = snapshot.capturedAt.replace(/[:.]/g, "-");

  atomicJsonWrite(path.join(snapshotsDir, stamp + ".json"), snapshot);
  atomicJsonWrite(path.join(dir, "latest.json"), snapshot);
  atomicJsonWrite(path.join(dir, "findings.json"), {
    schemaVersion: 1,
    evidenceVersion: snapshot.evidenceVersion || null,
    scoringPolicyKey: snapshot.scoringPolicy?.key || "local-v1",
    updatedAt: new Date().toISOString(),
    items: Object.fromEntries(findings.map(f => [f.id, f]))
  });
  recordProjectMetadata(
    projectId,
    snapshot.project?.displayName || projectId,
    snapshot.capturedAt,
    findings
  );

  for (const encrypted of [
    path.join(dir, "latest.enc"),
    path.join(dir, "findings.enc")
  ]) {
    try { fs.unlinkSync(encrypted); } catch {}
  }

  const files = fs.readdirSync(snapshotsDir)
    .filter(name => name.endsWith(".json"))
    .sort();
  for (const old of files.slice(0, Math.max(0, files.length - 60))) {
    try { fs.unlinkSync(path.join(snapshotsDir, old)); } catch {}
  }
}

export function listRecentSnapshots(projectId, limit = 10) {
  const dir = path.join(projectStateDir(projectId), "snapshots");
  if (!fs.existsSync(dir)) return [];

  for (const name of fs.readdirSync(dir).filter(name => name.endsWith(".enc"))) {
    const encrypted = path.join(dir, name);
    const json = path.join(dir, name.replace(/\.enc$/, ".json"));
    migrateOneEncrypted(encrypted, json);
  }

  return fs.readdirSync(dir)
    .filter(name => name.endsWith(".json"))
    .sort()
    .slice(-limit)
    .map(name => safeJsonRead(path.join(dir, name), null))
    .filter(Boolean);
}
