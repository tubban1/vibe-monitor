import fs from "node:fs";
import path from "node:path";
import { atomicJsonWrite, safeJsonRead, sha256 } from "./utils.js";
import { decryptJson } from "./secure-store.js";
import { projectStateDir } from "./history.js";

const DEFAULT_REMINDER_MS = 7 * 24 * 60 * 60 * 1000;

function noticeJsonFile(projectId) {
  return path.join(projectStateDir(projectId), "notice-state.json");
}

function noticeEncryptedFile(projectId) {
  return path.join(projectStateDir(projectId), "notice-state.enc");
}

function migrateEncryptedNotice(projectId) {
  const json = noticeJsonFile(projectId);
  const enc = noticeEncryptedFile(projectId);
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

function signature(finding) {
  const signals = (finding?.signals || [])
    .map(signal => [signal.name, signal.bucket || null])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return sha256(JSON.stringify({
    family: finding?.family || null,
    stage: finding?.stage || null,
    signals
  })).slice(0, 24);
}

function load(projectId) {
  migrateEncryptedNotice(projectId);
  return safeJsonRead(noticeJsonFile(projectId), { schemaVersion: 1, items: {} });
}

export function shouldSurfaceNotice(projectId, finding, { now = Date.now(), reminderMs = DEFAULT_REMINDER_MS } = {}) {
  const state = load(projectId);
  const previous = state.items?.[finding.id];
  if (!previous) return true;
  const nextSignature = signature(finding);
  if (previous.signature !== nextSignature) return true;
  const lastShown = Date.parse(previous.lastShownAt || "");
  if (!Number.isFinite(lastShown)) return true;
  return now - lastShown >= reminderMs;
}

export function markSurfacedNotices(projectId, findings, { now = Date.now() } = {}) {
  if (!findings?.length) return;
  const state = load(projectId);
  state.schemaVersion = 1;
  state.items ||= {};
  const at = new Date(now).toISOString();

  for (const finding of findings) {
    state.items[finding.id] = {
      signature: signature(finding),
      stage: finding.stage,
      family: finding.family,
      lastShownAt: at
    };
  }

  atomicJsonWrite(noticeJsonFile(projectId), state);
  try { fs.unlinkSync(noticeEncryptedFile(projectId)); } catch {}
}
