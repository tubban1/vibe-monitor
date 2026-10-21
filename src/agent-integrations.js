import fs from "node:fs";
import path from "node:path";

// Additional coding-Agent integrations (1.0.10). Each one writes only a
// user-level MCP entry named "vibe-monitor" (plus, where the Agent has one, a
// user-level instructions file) through the shared ownership-checked writers
// in setup.js. New integrations are strict: a config that is not plain JSON
// (for example JSONC with comments) is never rewritten; the user is asked to
// add the entry manually instead.
export const EXTRA_AGENT_NAMES = Object.freeze([
  "opencode", "gemini-cli", "cline", "roo-code", "copilot", "kiro", "windsurf", "workbuddy"
]);
export const CORE_AGENT_NAMES = Object.freeze(["codex", "claude", "cursor", "antigravity", "trae"]);
// The one list of Agent names used for setup, CLI flags, MCP and telemetry labels.
export const ALL_AGENT_NAMES = Object.freeze([...CORE_AGENT_NAMES, ...EXTRA_AGENT_NAMES]);

// VS Code and its forks keep extension and MCP settings in the user profile.
const VSCODE_APPS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf", "Trae"];
export function vscodeUserDirs(home, platform = process.platform, env = process.env) {
  const base = platform === "darwin" ? path.join(home, "Library", "Application Support")
    : platform === "win32" ? (env.APPDATA || path.join(home, "AppData", "Roaming"))
    : (env.XDG_CONFIG_HOME || path.join(home, ".config"));
  return VSCODE_APPS.map(app => ({ app, dir: path.join(base, app, "User") }));
}

export function xdgConfig(home, env = process.env) {
  return env.XDG_CONFIG_HOME || path.join(home, ".config");
}

const stdio = spec => ({ command: spec.command, args: spec.args });

// Pure description of where and how each Agent is configured. Paths follow
// each vendor's documentation as of 2026-10; WorkBuddy is experimental.
export function extraAgentTargets(home, platform = process.platform, env = process.env) {
  const vscode = vscodeUserDirs(home, platform, env);
  // Extension settings exist only in the VS Code variants where it is installed.
  const inStorage = (extensionId, file) => vscode
    .map(({ app, dir }) => ({ app, extDir: path.join(dir, "globalStorage", extensionId),
      file: path.join(dir, "globalStorage", extensionId, "settings", file) }))
    .filter(x => fs.existsSync(x.extDir));
  const config = xdgConfig(home, env);
  return {
    opencode: {
      detect: [path.join(config, "opencode")], commands: ["opencode"],
      mcp: [{ file: path.join(config, "opencode", "opencode.json"), key: "mcp",
        entry: spec => ({ type: "local", command: [spec.command, ...spec.args], enabled: true }) }],
      instructions: { file: path.join(config, "opencode", "AGENTS.md"), style: "block" }
    },
    "gemini-cli": {
      detect: [path.join(home, ".gemini", "settings.json")], commands: ["gemini"],
      mcp: [{ file: path.join(home, ".gemini", "settings.json"), key: "mcpServers", entry: stdio }],
      instructions: { file: path.join(home, ".gemini", "GEMINI.md"), style: "block" }
    },
    cline: {
      detect: [path.join(home, ".cline"), ...inStorage("saoudrizwan.claude-dev", "").map(x => x.extDir)],
      commands: ["cline"],
      mcp: [
        ...(fs.existsSync(path.join(home, ".cline")) ? [{ file: path.join(home, ".cline", "data", "settings", "cline_mcp_settings.json") }] : []),
        ...inStorage("saoudrizwan.claude-dev", "cline_mcp_settings.json")
      ].map(x => ({ file: x.file, key: "mcpServers", entry: spec => ({ ...stdio(spec), disabled: false }) }))
    },
    "roo-code": {
      detect: inStorage("rooveterinaryinc.roo-cline", "").map(x => x.extDir), commands: [],
      mcp: inStorage("rooveterinaryinc.roo-cline", "mcp_settings.json")
        .map(x => ({ file: x.file, key: "mcpServers", entry: spec => ({ ...stdio(spec), disabled: false }) }))
    },
    copilot: {
      detect: [path.join(home, ".copilot"), ...vscode.filter(x => ["Code", "Code - Insiders"].includes(x.app)).map(x => x.dir)],
      commands: ["copilot"],
      mcp: [
        ...(fs.existsSync(path.join(home, ".copilot")) ? [{ file: path.join(home, ".copilot", "mcp-config.json"), key: "mcpServers",
          entry: spec => ({ type: "local", ...stdio(spec), tools: ["*"] }) }] : []),
        // VS Code agent mode: user-profile mcp.json uses "servers".
        ...vscode.filter(x => ["Code", "Code - Insiders"].includes(x.app) && fs.existsSync(x.dir))
          .map(x => ({ file: path.join(x.dir, "mcp.json"), key: "servers", entry: spec => ({ type: "stdio", ...stdio(spec) }) }))
      ]
    },
    kiro: {
      detect: [path.join(home, ".kiro")], commands: ["kiro"],
      mcp: [{ file: path.join(home, ".kiro", "settings", "mcp.json"), key: "mcpServers", entry: spec => ({ ...stdio(spec), disabled: false }) }],
      instructions: { file: path.join(home, ".kiro", "steering", "vibe-monitor.md"), style: "owned" }
    },
    windsurf: {
      detect: [path.join(home, ".codeium", "windsurf")], commands: ["windsurf"],
      mcp: [{ file: path.join(home, ".codeium", "windsurf", "mcp_config.json"), key: "mcpServers", entry: stdio }],
      instructions: { file: path.join(home, ".codeium", "windsurf", "memories", "global_rules.md"), style: "block" }
    },
    workbuddy: {
      detect: [path.join(home, ".workbuddy")], commands: [],
      mcp: [{ file: path.join(home, ".workbuddy", ".mcp.json"), key: "mcpServers", entry: stdio }],
      experimental: true
    }
  };
}

// io: { writeMcpJson, removeMcpJson, hasMcp, appendManagedBlock, removeManagedBlock,
//       hasBlock, writeOwnedFile, removeOwnedFile, commandExists, specForAgent, instruction }
export function extraAgentAdapters(home, spec, io, platform = process.platform, env = process.env) {
  const targets = extraAgentTargets(home, platform, env);
  return Object.fromEntries(Object.entries(targets).map(([agent, t]) => {
    const agentSpec = io.specForAgent(spec, agent);
    const instruction = t.instructions;
    const install = () => [
      ...t.mcp.map(m => ({ agent, kind: "mcp", ...io.writeMcpJson(m.file, m.entry(agentSpec), { key: m.key, strict: true }) })),
      ...(instruction ? [{ agent, kind: "instructions", ...(instruction.style === "owned"
        ? io.writeOwnedFile(instruction.file, io.instruction + "\n") : io.appendManagedBlock(instruction.file)) }] : [])
    ];
    const remove = () => [
      ...t.mcp.map(m => ({ agent, kind: "mcp", changed: io.removeMcpJson(m.file, { key: m.key, strict: true }) })),
      ...(instruction ? [{ agent, kind: "instructions", changed: instruction.style === "owned"
        ? io.removeOwnedFile(instruction.file) : io.removeManagedBlock(instruction.file) }] : [])
    ];
    return [agent, {
      experimental: Boolean(t.experimental),
      detect: () => t.detect.some(p => fs.existsSync(p)) || t.commands.some(c => io.commandExists(c)),
      plan: () => [...t.mcp.map(m => ({ agent, action: "mcp", file: m.file })),
        ...(instruction ? [{ agent, action: "instructions", file: instruction.file }] : [])]
        .map(x => t.experimental ? { ...x, experimental: true } : x),
      install, uninstall: remove,
      status: () => {
        const values = [...t.mcp.map(m => io.hasMcp(m.file, m.key)),
          ...(instruction ? [instruction.style === "owned" ? fs.existsSync(instruction.file) : io.hasBlock(instruction.file)] : [])];
        return values.some(x => x === true) ? "present" : values.some(x => x === null) ? "unknown" : "absent";
      }
    }];
  }));
}
