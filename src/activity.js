import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ensureDir, safeJsonRead, vibeHome } from "./utils.js";
import { enqueueActivityTelemetry } from "./telemetry.js";

export function activityFile() {
  return path.join(vibeHome(), "activity.jsonl");
}

function processCommand(pid) {
  if (!pid || pid <= 1) return null;
  try {
    const out = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (out.status !== 0 || !out.stdout.trim()) return null;
    const line = out.stdout.trim();
    const match = line.match(/^\s*(\d+)\s+(.*)$/s);
    if (!match) return null;
    return { ppid: Number(match[1]), command: match[2] };
  } catch {
    return null;
  }
}

export function classifyAgentProcess(commandLine = "") {
  const command = String(commandLine || "").toLowerCase().trim();
  if (!command) return null;

  const executable = command.split(/\s+/)[0].replace(/^["']|["']$/g, "");
  const executableBase = path.basename(executable).toLowerCase();

  if (
    executableBase === "antigravity" ||
    executable.includes("/antigravity.app/contents/macos/antigravity")
  ) return "antigravity";

  if (
    executableBase === "codex" ||
    executableBase === "codex-cli" ||
    executable.includes("/@openai/codex/")
  ) return "codex";

  if (
    executableBase === "claude" ||
    executableBase === "claude-code" ||
    executable.includes("/@anthropic-ai/claude-code/")
  ) return "claude";

  if (
    executableBase === "trae" || executableBase === "trae.exe" ||
    executable.includes("/trae.app/contents/")
  ) return "trae";

  if (
    executableBase === "cursor" ||
    executable.includes("/cursor.app/contents/macos/cursor")
  ) return "cursor";

  return null;
}

export function detectAgentHost(startPid = process.ppid) {
  let pid = startPid;
  for (let depth = 0; depth < 5 && pid > 1; depth++) {
    const info = processCommand(pid);
    if (!info) break;
    const agent = classifyAgentProcess(info.command);
    if (agent) return agent;
    pid = info.ppid;
  }
  return "unknown";
}

function compactActivity(event, {
  agent = "unknown",
  result = null,
  finding = null,
  sessionId = null,
  callId = null,
  durationMs = null,
  monitoringMode = null,
  monitoringWallTimeMs = null
} = {}) {
  return {
    schemaVersion: 1,
    at: new Date().toISOString(),
    event,
    agent,
    sessionId,
    callId,
    scanId: result?.monitoring?.scanId || null,
    projectId: result?.project?.id || null,
    repoId: result?.project?.repoId || null,
    projectInstanceId: result?.project?.projectInstanceId || result?.project?.id || null,
    stage: finding?.stage || result?.status?.highestStage || null,
    attentionRequired: finding?.requiresAttention ?? result?.status?.attentionRequired ?? null,
    findingCount: result?.status?.findingCount ?? null,
    attentionCount: result?.status?.attentionCount ?? null,
    durationMs: durationMs ?? result?.durationMs ?? null,
    monitoringMode: monitoringMode || result?.monitoring?.mode || null,
    monitoringWallTimeMs: monitoringWallTimeMs ?? result?.monitoring?.wallTimeMs ?? null,
    scannerOverheadPct: result?.monitoring?.scannerOverheadPct ?? null,
    findingId: finding?.id || null,
    family: finding?.family || null
  };
}

export function appendActivity(event, options = {}) {
  const item = compactActivity(event, options);
  const file = activityFile();
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(item) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  try {
    if (!options.localOnly) enqueueActivityTelemetry(item, options.result?.transitions || [], options.result || null);
  } catch {
    // Telemetry is strictly best-effort and must never affect coding.
  }
  return item;
}

export function readActivity({ limit = 50 } = {}) {
  const file = activityFile();
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines.slice(-Math.max(1, limit)).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function formatActivity(item) {
  const when = item.at ? item.at.replace("T", " ").replace(/\.\d{3}Z$/, "Z") : "-";
  const agent = String(item.agent || "unknown").padEnd(11);
  const project = item.projectId ? item.projectId.slice(0, 12) : "-";
  const stage = item.stage || "-";
  const attention = item.attentionRequired == null ? "-" : item.attentionRequired ? "yes" : "no";
  const duration = item.durationMs == null ? "" : " scan=" + item.durationMs + "ms";
  const mode = item.monitoringMode ? " mode=" + item.monitoringMode : "";
  const finding = item.findingId ? " " + item.findingId : "";
  return `${when}  ${agent} ${String(item.event).padEnd(18)} project=${project} stage=${stage} attention=${attention}${mode}${duration}${finding}`;
}

export function activityCursor() {
  const file = activityFile();
  try { return fs.statSync(file).size; } catch { return 0; }
}

export function readActivityFrom(offset = 0) {
  const file = activityFile();
  if (!fs.existsSync(file)) return { nextOffset: 0, items: [] };
  const size = fs.statSync(file).size;
  if (size <= offset) return { nextOffset: size, items: [] };
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const items = buffer.toString("utf8").split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    return { nextOffset: size, items };
  } finally {
    fs.closeSync(fd);
  }
}
