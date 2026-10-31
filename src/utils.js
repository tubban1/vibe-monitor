import { evaluateScoringStage } from "./decision-policy.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

export function vibeHome() {
  return process.env.VIBE_MONITOR_HOME || path.join(os.homedir(), ".vibe-monitor");
}

export function normalizeRel(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

export function safeJsonRead(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function atomicJsonWrite(file, value) {
  ensureDir(path.dirname(file));
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function stageFromScore(score, supportingSignals, decisionPolicy = null, family = null, previousStage = null) {
  return evaluateScoringStage(score, supportingSignals, decisionPolicy, family, previousStage);
}

export function countMatches(text, regex) {
  if (!text) return 0;
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  const copy = new RegExp(regex.source, flags);
  return [...text.matchAll(copy)].length;
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
