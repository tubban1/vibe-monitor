import fs from "node:fs";
import path from "node:path";
import { ensureDir, vibeHome } from "./utils.js";
import { enqueueFeedbackTelemetry } from "./telemetry.js";

export const FEEDBACK_VERDICTS = new Set([
  "useful",
  "false_positive",
  "too_early",
  "too_late",
  "confusing"
]);

export function feedbackFile() {
  return path.join(vibeHome(), "feedback.jsonl");
}

export function appendFeedback({
  agent = "unknown",
  sessionId = null,
  callId = null,
  scanId = null,
  projectId,
  repoId = null,
  projectInstanceId = null,
  findingId,
  family = null,
  stage = null,
  actionMode = null,
  verdict,
  note = null
}) {
  if (!FEEDBACK_VERDICTS.has(verdict)) {
    throw new Error("invalid_feedback_verdict");
  }
  const item = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    agent,
    sessionId,
    callId,
    scanId,
    projectId,
    repoId,
    projectInstanceId,
    findingId,
    family,
    stage,
    actionMode,
    verdict,
    note: typeof note === "string" && note.trim()
      ? note.trim().slice(0, 500)
      : null
  };
  const file = feedbackFile();
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(item) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  try {
    enqueueFeedbackTelemetry(item);
  } catch {
    // Telemetry must never block local feedback capture.
  }
  return item;
}

export function readFeedback({ limit = 50 } = {}) {
  const file = feedbackFile();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-Math.max(1, limit))
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}
