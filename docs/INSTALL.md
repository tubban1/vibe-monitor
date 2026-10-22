# Install Vibe Monitor — official stable client

The **public stable** release is `@vibe-monitor/setup@latest` (currently version `1.0.2`). One installer serves Free/Pro/Team. No activation code is needed.

## Install

```bash
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@latest install
```

The installer verifies the environment and configures supported coding Agent integration. It may modify **managed MCP and Agent instruction settings** (with scoped backup handling), but not project source code.

**No source-code upload:** Vibe Monitor analyzes source locally and does not transmit source files, diffs, prompts, project paths or credentials to its servers. Bounded pseudonymous product telemetry is disclosed during installation; details and user controls are documented in the [telemetry and privacy contract](governance/TELEMETRY_PRIVACY_V1.md).

## Verify

Verify the actual installed version, supported Agent MCP integration, `vibe-monitor doctor --json`, `vibe-monitor telemetry status` and one read-only architecture scan in an accessible code project. Do not report success unless installation and integration have really been verified.

## Local maintenance

`vibe-monitor uninstall` disconnects managed Agent integration but does not promise deletion of every runtime file, backup, local history or previously accepted Cloud record. See [security](../SECURITY.md).

For historical version-specific migration, rollback and incident information, consult [release audit records](RELEASE_AUDIT_1.0.2.md); they are not current fresh-install instructions.

[Code project suitability assessment](AGENT_EVALUATION.md) · [Telemetry controls and field list](governance/TELEMETRY_PRIVACY_V1.md).

## Supported coding Agents

The installer detects these Agents and adds a user-level `vibe-monitor` MCP entry (plus a user-level instructions file where the Agent has one). Pass `--<name>` to configure one explicitly, for example `--opencode`.

| Agent | `--name` | Where |
|---|---|---|
| Codex | `codex` | `~/.codex/config.toml`, `~/.codex/AGENTS.md` |
| Claude Code | `claude` | `~/.claude.json`, `~/.claude/CLAUDE.md` |
| Cursor | `cursor` | `~/.cursor/mcp.json`, `~/.cursor/rules/vibe-monitor.mdc` |
| Antigravity | `antigravity` | `~/.gemini/config/mcp_config.json`, `~/.gemini/GEMINI.md` |
| Trae | `trae` | Trae user `mcp.json` |
| OpenCode | `opencode` | `~/.config/opencode/opencode.json` (`mcp`), `~/.config/opencode/AGENTS.md` |
| Gemini CLI | `gemini-cli` | `~/.gemini/settings.json`, `~/.gemini/GEMINI.md` |
| Cline | `cline` | Cline CLI `~/.cline/data/settings/`, and the Cline extension in each VS Code-family editor |
| Roo Code | `roo-code` | Roo Code extension settings in each VS Code-family editor |
| GitHub Copilot | `copilot` | Copilot CLI `~/.copilot/mcp-config.json`; VS Code user `mcp.json` (`servers`) |
| Kiro | `kiro` | `~/.kiro/settings/mcp.json`, `~/.kiro/steering/vibe-monitor.md` |
| Windsurf | `windsurf` | `~/.codeium/windsurf/mcp_config.json`, global rules |
| WorkBuddy (experimental) | `workbuddy` | `~/.workbuddy/.mcp.json` |

An existing config that is not plain JSON (for example with comments) is left unchanged and the installer asks you to add the entry manually. Uninstall removes only entries Vibe Monitor wrote.
