import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import JSON5 from "json5";
import {CLIENT_VERSION} from "./constants.js";
import {ALL_AGENT_NAMES, EXTRA_AGENT_NAMES, extraAgentAdapters} from "./agent-integrations.js";

const START = "<!-- vibe-monitor:start -->";
const END = "<!-- vibe-monitor:end -->";
const INSTRUCTION = [
  START,
  "## Vibe Monitor",
  "",
  "Vibe Monitor is a session-scoped software-evolution observer. It does not modify project source code.",
  "",
  "At the start of any coding-project session, before the first project inspection, plan, or code change, if Vibe Monitor tools are available, call `vibe_session_start` exactly once.",
  "Do this even when the user's first request is read-only, such as checking project status or understanding the codebase.",
  "After a meaningful implementation batch, call `vibe_checkpoint`.",
  "If `attentionRequired=false`, do not call `vibe_findings` or `vibe_explain_finding`. If the assessment is incomplete, the status is unknown, not healthy: still tell the user when `userNoticeRequired=true`.",
  "If `userNoticeRequired=true`, make the returned Vibe notice visible to the user in your normal response. Use the provided `userFacing` text instead of exposing internal metric names unless the user asks for details.",
  "Vibe applies an attention budget: normal responses should surface at most two different monitor families, even if more internal findings exist. Do not expand suppressed findings unless the current task needs them or the user asks.",
  "Keep the notice short and practical: what is getting hard to change, why that matters in plain language, what to do this time, what not to do yet, and when it becomes worth doing more.",
  "If `improvements` is non-empty, tell the user that the earlier problem is getting better and include the stage change. This closes the loop so the user knows whether an architectural adjustment actually helped.",
  "Only when attention is required should you inspect or explain the relevant finding before adding more structural complexity.",
  "For high-impact choices such as database/cloud/service/worker/multi-user architecture, use Vibe product-intent context. If a material intent fact is unknown, ask at most one simple user question only when the current decision truly depends on it. If the user clearly states product intent, record only that explicit fact with `vibe_set_product_intent`; never turn a guess into explicit intent.",
  "Do not repeat an unchanged finding on every checkpoint in the same session; surface it again only when it gets worse, improves, changes stage, or directly affects the current task.",
  "",
  "Treat findings as advisory evidence. Never refactor unrelated code just to satisfy a finding.",
  "For S3, continue development but avoid putting more unrelated work into the same pressured area.",
  "For S4, if the current task touches that area, first put the new piece behind a small clear boundary when practical instead of continuing to pile work into the same place.",
  "For S5, strongly recommend fixing the local problem before adding more complexity, while keeping the user in control.",
  "Avoid jargon such as fan-out, co-change, responsibility concentration, ownership boundary, characterization, or blast radius in user-facing notices unless the user asks for technical detail.",
  "If the user explicitly says a Vibe warning was useful, wrong/false-positive, too early, too late, or confusing, call `vibe_feedback` once with that verdict. Do not ask for feedback after every warning.",
  END
].join("\n");

function setupHome() {
  return process.env.VIBE_MONITOR_SETUP_HOME || os.homedir();
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const target = file + ".vibe-monitor.bak";
  if (!fs.existsSync(target)) fs.copyFileSync(file, target);
  return target;
}
function appendManagedBlock(file, content = INSTRUCTION) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const start = existing.indexOf(START);
  const end = existing.indexOf(END);
  if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) {
    return {changed:false,file,manualRequired:true,error:"existing_instruction_marker_malformed"};
  }
  if (start >= 0) {
    const current = existing.slice(start,end+END.length);
    // Do not claim or remove a matching block left by another Vibe distribution.
    if (current === content) return {changed:false,file};
    if (!isOwned(file,current)) return refuseConflict(file);
    backup(file);
    fs.writeFileSync(file,existing.slice(0,start)+content+existing.slice(end+END.length),"utf8");
    markOwned(file,content);
    return {changed:true,file,updated:true};
  }
  backup(file);
  const sep = existing.length && !existing.endsWith("\n") ? "\n\n" : existing.length ? "\n" : "";
  fs.writeFileSync(file,existing+sep+content+"\n","utf8");
  markOwned(file,content);
  return {changed:true,file};
}
function removeManagedBlock(file) {
  if (!fs.existsSync(file)) return false;
  const original = fs.readFileSync(file,"utf8");
  const start = original.indexOf(START);
  const end = original.indexOf(END);
  if (start < 0 || end < start) return false;
  const block = original.slice(start,end+END.length);
  if (!isOwned(file,block)) return false;
  backup(file);
  fs.writeFileSync(file,original.slice(0,start)+original.slice(end+END.length),"utf8");
  clearOwned(file);
  return true;
}
function readJson(file, { strict = false } = {}) {
  if (!fs.existsSync(file)) return { ok: true, value: {} };
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch {
    // Strict callers never rewrite JSONC: comments would be lost.
    if (strict) return { ok: false, value: null };
    try { return { ok: true, value: JSON5.parse(raw) }; }
    catch { return { ok: false, value: null }; }
  }
}
// Ownership receipts contain hashes only: never copy another Agent's settings or secrets.
function ownerPath(file) { return file + ".vibe-monitor-owned.json"; }
function ownedHash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function isOwned(file, value) {
  try {
    const receipt = JSON.parse(fs.readFileSync(ownerPath(file), "utf8"));
    return receipt.version === 1 && receipt.sha256 === ownedHash(value);
  } catch { return false; }
}
function markOwned(file, value) {
  fs.writeFileSync(ownerPath(file), JSON.stringify({version:1,sha256:ownedHash(value)}) + "\n",
    {encoding:"utf8",mode:0o600});
}
function clearOwned(file) { fs.rmSync(ownerPath(file), {force:true}); }
function refuseConflict(file) {
  return {changed:false,file,manualRequired:true,error:"existing_vibe_monitor_registration_preserved"};
}
function writeMcpJson(file, serverConfig, { key = "mcpServers", strict = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const parsed = readJson(file, { strict });
  if (!parsed.ok) return {changed:false,file,manualRequired:true,error:"existing_config_not_strict_json_preserved"};
  const json = parsed.value;
  if (!json || typeof json !== "object" || Array.isArray(json) ||
      (json[key] !== undefined && (!json[key] || typeof json[key] !== "object" || Array.isArray(json[key]))))
    return refuseConflict(file);
  json[key] ||= {};
  const previous = json[key]["vibe-monitor"];
  const expected = JSON.stringify(serverConfig);
  if (previous !== undefined) {
    const actual = JSON.stringify(previous);
    if (actual === expected) return {changed:false,file};
    if (!isOwned(file, actual)) return refuseConflict(file);
  }
  backup(file);
  json[key]["vibe-monitor"] = serverConfig;
  fs.writeFileSync(file, JSON.stringify(json,null,2) + "\n", "utf8");
  markOwned(file, expected);
  return {changed:true,file};
}
function removeMcpJson(file, { key = "mcpServers", strict = false } = {}) {
  if (!fs.existsSync(file)) return false;
  const parsed = readJson(file, { strict });
  if (!parsed.ok) return false;
  const json = parsed.value;
  const previous = json?.[key]?.["vibe-monitor"];
  if (previous === undefined || !isOwned(file, JSON.stringify(previous))) return false;
  backup(file);
  delete json[key]["vibe-monitor"];
  fs.writeFileSync(file, JSON.stringify(json,null,2) + "\n", "utf8");
  clearOwned(file);
  return true;
}
function findCodexBlock(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(line => line.trim() === "[mcp_servers.vibe-monitor]");
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++)
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) { end = i; break; }
  return {lines,start,end,current:lines.slice(start,end).join("\n").trim()};
}
function writeCodexToml(file, spec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = fs.existsSync(file) ? fs.readFileSync(file,"utf8") : "";
  const block = "[mcp_servers.vibe-monitor]\ncommand = " + JSON.stringify(spec.command) +
    "\nargs = [" + spec.args.map(v => JSON.stringify(v)).join(", ") + "]\n";
  const found = findCodexBlock(text);
  if (found) {
    if (found.current === block.trim()) return {changed:false,file};
    if (!isOwned(file, found.current)) return refuseConflict(file);
    backup(file);
    const next = [...found.lines.slice(0,found.start),...block.trimEnd().split("\n"),
      ...found.lines.slice(found.end)].join("\n").replace(/\n{3,}/g,"\n\n").trimEnd() + "\n";
    fs.writeFileSync(file,next,"utf8");
    markOwned(file,block.trim());
    return {changed:true,updated:true,file};
  }
  backup(file);
  fs.writeFileSync(file,text.trimEnd()+(text.trim()?"\n\n":"")+block,"utf8");
  markOwned(file,block.trim());
  return {changed:true,file};
}
function removeCodexToml(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file,"utf8");
  const found = findCodexBlock(text);
  if (!found || !isOwned(file,found.current)) return false;
  backup(file);
  fs.writeFileSync(file,[...found.lines.slice(0,found.start),...found.lines.slice(found.end)]
    .join("\n").replace(/\n{3,}/g,"\n\n").trimEnd()+"\n","utf8");
  clearOwned(file);
  return true;
}
function writeOwnedFile(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if (fs.existsSync(file)) {
    const previous = fs.readFileSync(file,"utf8");
    if (previous === value) return {changed:false,file};
    if (!isOwned(file,previous)) return refuseConflict(file);
  }
  backup(file);
  fs.writeFileSync(file,value,"utf8");
  markOwned(file,value);
  return {changed:true,file};
}
function removeOwnedFile(file) {
  if (!fs.existsSync(file) || !isOwned(file,fs.readFileSync(file,"utf8"))) return false;
  backup(file);
  fs.unlinkSync(file);
  clearOwned(file);
  return true;
}
function commandExists(command) {
  if (process.env.VIBE_MONITOR_SETUP_HOME && !process.env.VIBE_MONITOR_ALLOW_EXTERNAL_CLI) return false;
  try {
    execFileSync("/usr/bin/env", ["sh", "-lc", "command -v " + command], { stdio: "ignore" });
    return true;
  } catch { return false; }
}
export function runtimeSpec(options = {}) {
  if (options.runtimeCommand) return { command: options.runtimeCommand, args: ["mcp"] };
  if (options.local) return { command: "node", args: [path.resolve(options.cliPath), "mcp"] };
  // Last-resort setup-only fallback: never select a stale npm dist-tag or regional mirror.
  // Normal installs use the verified, rollback-capable local launcher instead.
  return { command: "npx", args: ["-y", "--registry=https://registry.npmjs.org",
    `@vibe-monitor/setup@${CLIENT_VERSION}`, "mcp"] };
}
export const AGENT_ADAPTER_NAMES = ALL_AGENT_NAMES;

// TRAE's user-level MCP config is distinct from ~/.trae/mcps (tool cache).
// Keep Vibe global and do not write into monitored project directories.
export function traeMcpConfigFile(home = setupHome(), platform = process.platform, env = process.env) {
  const base = platform === "win32"
    ? (env.APPDATA && !process.env.VIBE_MONITOR_SETUP_HOME
      ? env.APPDATA : path.join(home, "AppData", "Roaming"))
    : platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : path.join(home, ".config");
  // TRAE and TRAE CN use different application-data folders. Prefer an
  // existing real config, then an existing User folder, over creating a
  // disconnected international config next to an installed China client.
  const candidates = ["Trae", "Trae CN"].map(name => path.join(base, name, "User", "mcp.json"));
  return candidates.find(file => fs.existsSync(file))
    || candidates.find(file => fs.existsSync(path.dirname(file)))
    || candidates[0];
}

function specForAgent(spec, agent) {
  return {
    ...spec,
    args: [...(spec.args || []), "--agent", agent]
  };
}

function createAgentAdapters(home, spec) {
  const codexSpec = specForAgent(spec, "codex");
  const claudeSpec = specForAgent(spec, "claude");
  const cursorSpec = specForAgent(spec, "cursor");
  const antigravitySpec = specForAgent(spec, "antigravity");
  const traeSpec = specForAgent(spec, "trae");

  const core = {
    codex: {
      detect: () => fs.existsSync(path.join(home, ".codex")) || commandExists("codex"),
      plan: () => [
        { agent: "codex", action: "mcp", file: path.join(home, ".codex", "config.toml") },
        { agent: "codex", action: "instructions", file: path.join(home, ".codex", "AGENTS.md") }
      ],
      install: () => [
        { agent: "codex", kind: "mcp", ...writeCodexToml(path.join(home, ".codex", "config.toml"), codexSpec) },
        { agent: "codex", kind: "instructions", ...appendManagedBlock(path.join(home, ".codex", "AGENTS.md")) }
      ],
      uninstall: () => [
        { agent: "codex", kind: "mcp", changed: removeCodexToml(path.join(home, ".codex", "config.toml")) },
        { agent: "codex", kind: "instructions", changed: removeManagedBlock(path.join(home, ".codex", "AGENTS.md")) }
      ]
    },
    claude: {
      detect: () => fs.existsSync(path.join(home, ".claude.json")) ||
        fs.existsSync(path.join(home, ".claude")) || commandExists("claude"),
      plan: () => [
        { agent: "claude", action: "mcp", file: path.join(home, ".claude.json"), scope: "user" },
        { agent: "claude", action: "instructions", file: path.join(home, ".claude", "CLAUDE.md") }
      ],
      // Claude Code user-scope MCP lives in ~/.claude.json.
      // Never call `claude mcp remove` to replace a potentially user-owned server.
      install: () => [
        { agent: "claude", kind: "mcp", ...writeMcpJson(path.join(home, ".claude.json"), claudeSpec) },
        { agent: "claude", kind: "instructions", ...appendManagedBlock(path.join(home, ".claude", "CLAUDE.md")) }
      ],
      uninstall: () => [
        { agent: "claude", kind: "mcp", changed: removeMcpJson(path.join(home, ".claude.json")) },
        { agent: "claude", kind: "instructions", changed: removeManagedBlock(path.join(home, ".claude", "CLAUDE.md")) }
      ]
    },
    cursor: {
      detect: () => fs.existsSync(path.join(home, ".cursor")) || commandExists("cursor"),
      plan: () => [
        { agent: "cursor", action: "mcp", file: path.join(home, ".cursor", "mcp.json") },
        { agent: "cursor", action: "instructions", file: path.join(home, ".cursor", "rules", "vibe-monitor.mdc") }
      ],
      install: () => {
        const changes = [
          { agent: "cursor", kind: "mcp", ...writeMcpJson(path.join(home, ".cursor", "mcp.json"), cursorSpec) }
        ];
        const ruleFile = path.join(home, ".cursor", "rules", "vibe-monitor.mdc");
        const cursorRule = "---\ndescription: Vibe Monitor session activation\nalwaysApply: true\n---\n\n" + INSTRUCTION + "\n";
        changes.push({agent:"cursor",kind:"instructions",...writeOwnedFile(ruleFile,cursorRule)});
        return changes;
      },
      uninstall: () => {
        const changes = [
          { agent: "cursor", kind: "mcp", changed: removeMcpJson(path.join(home, ".cursor", "mcp.json")) }
        ];
        const ruleFile = path.join(home, ".cursor", "rules", "vibe-monitor.mdc");
        if (removeOwnedFile(ruleFile)) changes.push({agent:"cursor",kind:"instructions",changed:true});
        return changes;
      }
    },
    trae: {
      detect: () => fs.existsSync(traeMcpConfigFile(home)) ||
        fs.existsSync(path.join(home, ".trae")) ||
        (!process.env.VIBE_MONITOR_SETUP_HOME && (
          (process.platform === "darwin" && fs.existsSync("/Applications/Trae.app")) ||
          commandExists("trae")
        )),
      plan: () => [
        { agent: "trae", action: "mcp", file: traeMcpConfigFile(home), scope: "user" }
      ],
      install: () => [
        { agent: "trae", kind: "mcp", ...writeMcpJson(traeMcpConfigFile(home), traeSpec) }
      ],
      uninstall: () => [
        { agent: "trae", kind: "mcp", changed: removeMcpJson(traeMcpConfigFile(home)) }
      ]
    },
    antigravity: {
      detect: () => fs.existsSync(path.join(home, ".gemini")),
      plan: () => [
        { agent: "antigravity", action: "mcp", file: path.join(home, ".gemini", "config", "mcp_config.json") },
        { agent: "antigravity", action: "instructions", file: path.join(home, ".gemini", "GEMINI.md") }
      ],
      install: () => [
        { agent: "antigravity", kind: "mcp", ...writeMcpJson(path.join(home, ".gemini", "config", "mcp_config.json"), antigravitySpec) },
        { agent: "antigravity", kind: "instructions", ...appendManagedBlock(path.join(home, ".gemini", "GEMINI.md")) }
      ],
      uninstall: () => [
        { agent: "antigravity", kind: "mcp", changed: removeMcpJson(path.join(home, ".gemini", "config", "mcp_config.json")) },
        { agent: "antigravity", kind: "instructions", changed: removeManagedBlock(path.join(home, ".gemini", "GEMINI.md")) }
      ]
    }
  };
  // A setup-home override (tests, sandboxes) must never reach real profile
  // directories through APPDATA or XDG_CONFIG_HOME.
  const env = process.env.VIBE_MONITOR_SETUP_HOME ? {} : process.env;
  const extra = extraAgentAdapters(home, spec, {
    writeMcpJson, removeMcpJson, hasMcp: hasMcpEntry, appendManagedBlock, removeManagedBlock,
    hasBlock: hasManagedBlock, writeOwnedFile, removeOwnedFile, commandExists, specForAgent, instruction: INSTRUCTION
  }, process.platform, env);
  return { ...core, ...extra };
}

function hasManagedBlock(file) {
  try { return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(START); }
  catch { return null; }
}
function hasMcpEntry(file, key = "mcpServers") {
  try {
    const parsed = readJson(file);
    return parsed.ok ? Boolean(parsed.value?.[key]?.["vibe-monitor"]) : null;
  } catch { return null; }
}

export function detectAgents() {
  const home = setupHome();
  const adapters = createAgentAdapters(home, runtimeSpec({}));
  return Object.fromEntries(AGENT_ADAPTER_NAMES.map(name => [name, adapters[name].detect()]));
}

export function installSetup(options = {}) {
  const home = setupHome();
  const spec = runtimeSpec(options);
  const adapters = createAgentAdapters(home, spec);
  const agents = Object.fromEntries(AGENT_ADAPTER_NAMES.map(name => [name, adapters[name].detect()]));
  const requestedAgents = Array.isArray(options.agents) && options.agents.length
    ? new Set(options.agents)
    : null;
  // Explicit agent flags request installation even on a fresh machine.
  const selectedAgents = AGENT_ADAPTER_NAMES.filter(name =>
    requestedAgents ? requestedAgents.has(name) : agents[name]
  );
  const plan = selectedAgents.flatMap(name => adapters[name].plan());

  if (options.dryRun) return { dryRun: true, agents, selectedAgents, runtime: spec, plan };

  const changes = selectedAgents.flatMap(name => adapters[name].install());
  return { dryRun: false, agents, selectedAgents, runtime: spec, changes };
}

// Read only: inspect known user-level Vibe registrations without executing
// coding-agent CLIs, scanning repositories, or collecting any file contents.
export function managedIntegrations() {
  const home = setupHome();
  const result = {};
  const hasBlock = file => {
    try { return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(START); }
    catch { return null; }
  };
  const hasText = (file, marker) => {
    try { return fs.existsSync(file) && fs.readFileSync(file, "utf8").includes(marker); }
    catch { return null; }
  };
  const hasMcp = file => {
    try {
      const parsed = readJson(file);
      return parsed.ok ? Boolean(parsed.value?.mcpServers?.["vibe-monitor"]) : null;
    } catch { return null; }
  };
  const combine = values => values.some(x => x === true) ? "present" :
    values.some(x => x === null) ? "unknown" : "absent";
  result.codex = combine([hasText(path.join(home, ".codex", "config.toml"), "[mcp_servers.vibe-monitor]"),
    hasBlock(path.join(home, ".codex", "AGENTS.md"))]);
  result.cursor = combine([hasMcp(path.join(home, ".cursor", "mcp.json")),
    hasBlock(path.join(home, ".cursor", "rules", "vibe-monitor.mdc"))]);
  result.trae = combine([hasMcp(traeMcpConfigFile(home))]);
  result.antigravity = combine([hasMcp(path.join(home, ".gemini", "config", "mcp_config.json")),
    hasBlock(path.join(home, ".gemini", "GEMINI.md"))]);
  result.claude = combine([hasMcp(path.join(home, ".claude.json")),
    hasBlock(path.join(home, ".claude", "CLAUDE.md"))]);
  const extra = createAgentAdapters(home, runtimeSpec({}));
  for (const name of EXTRA_AGENT_NAMES) result[name] = extra[name].status();
  return result;
}

export function classifyUninstallLifecycle(removal, integrationStates = managedIntegrations()) {
  const changes = removal?.changes || [];
  const changedAgents = [...new Set(changes.filter(x => x.changed === true).map(x => x.agent))]
    .filter(name => AGENT_ADAPTER_NAMES.includes(name));
  const remainingAgents = AGENT_ADAPTER_NAMES.filter(name => integrationStates[name] === "present");
  const unknownAgents = AGENT_ADAPTER_NAMES.filter(name => integrationStates[name] === "unknown");
  const errors = changes.some(x => x.error || x.manualRequired);
  const confirmed = changedAgents.length > 0 && !errors && !unknownAgents.length;
  const full = confirmed && !remainingAgents.length;
  return {
    outcome: changedAgents.length === 0 ? "no_change" : errors || unknownAgents.length ? "uncertain" :
      full ? "fully_unconfigured" : "partially_unconfigured",
    event: changedAgents.length === 0 ? null :
      full ? "lifecycle.uninstalled" : "lifecycle.integration_removed",
    scope: full ? "full" : "partial",
    agents: changedAgents,
    remainingAgents,
    verified: confirmed
  };
}

export function uninstallSetup(options = {}) {
  const home = setupHome();
  const adapters = createAgentAdapters(home, runtimeSpec(options));
  const requestedAgents = Array.isArray(options.agents) && options.agents.length
    ? new Set(options.agents)
    : null;
  const selectedAgents = AGENT_ADAPTER_NAMES.filter(name => !requestedAgents || requestedAgents.has(name));
  const changes = selectedAgents.flatMap(name => adapters[name].uninstall());
  return { changes };
}
