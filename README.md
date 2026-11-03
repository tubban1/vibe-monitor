# Vibe Monitor

[![AllMCPs listing](https://allmcps.com/api/badge/vibe-monitor)](https://allmcps.com/mcp/vibe-monitor?verify=28ea83f4-389c-4670-a934-3f0202997d1a)

**A local architecture advisor for AI coding workflows.** AI agents ship features fast; Vibe Monitor helps you see when architectural complexity is accumulating and what actually needs attention.

## The open-source MCP server

This repository contains an **actual local MCP server** (stdio transport), not only an npm installer or a cloud dashboard. The MCP server runs on your own computer and exposes read-only architecture checks and change-history snapshots to an MCP-capable coding agent. It does not rewrite your project source.

Example MCP tools implemented in [`src/mcp.js`](src/mcp.js):

| MCP tool | What it does locally |
| --- | --- |
| `vibe_session_start` | Start or resume a bounded assessment of one coding project |
| `vibe_project_status` | Read the current project's architecture signals without creating a snapshot |
| `vibe_checkpoint` | Record a post-change snapshot to compare structural evolution |
| `vibe_findings` | Show prioritized findings and concrete next steps |
| `vibe_evolution_audit` | Inspect architecture evolution across recorded checkpoints |
| `vibe_version` | Inspect the actual running/installed version |

**Install and register the local MCP server with supported agents:**

```sh
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@latest install
```

**Direct stdio MCP command** (for clients that configure `command` / `args` themselves; Node.js 22+):

```sh
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@latest mcp
```

The npm package implements both the installer and MCP server. The server's official name is `io.github.tubban1/vibe-monitor`; its [registry manifest](server.json) declares the local `mcp` argument. Some analysis features depend on the signed Cloud scoring policy; installing does not grant cloud access to your source code. See the telemetry details below.

## Get started — official stable release

The official open-source MCP server and installer are distributed through npm as **`@vibe-monitor/setup@latest`**. As verified on 2026-11-03, npm `latest` is **`1.0.14`**; the GitHub release and npm release workflow are complete.

```bash
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@latest install


```

On a new install, bounded **pseudonymous** product telemetry defaults **ON**, with notice. Use `install --no-telemetry` or `vibe-monitor telemetry off` to disable collection; this pauses Free architecture analysis. An existing opt-out survives reinstall. No activation code is required.

**Not sure whether your projects need it?** Give your coding Agent this one canonical instruction:

**[Analyze accessible code projects and return a direct recommendation →](docs/AGENT_EVALUATION.md)**

The Agent must inspect code projects already accessible in its current workspaces, decide which would benefit (if any), and report the results **to you in the chat**. No installation or external report submission occurs during the assessment.

## Your source code is not uploaded

**Vibe Monitor analyzes source locally. It never uploads source files, diffs, prompts, project paths or secrets to Vibe Monitor servers.** Bounded derived metrics and product-operation events can be sent through disclosed pseudonymous telemetry, not the code itself. You can **audit the open-source implementation** instead of relying on a marketing promise:

- [Local telemetry event projection and strict wire fields](src/telemetry.js)
- [Allowed telemetry field checks](src/telemetry-quality.js)
- [Outbound telemetry transport](src/cloud.js)
- [Detailed security boundaries](SECURITY.md) and [current telemetry/privacy contract](docs/governance/TELEMETRY_PRIVACY_V1.md)

The *coding Agent itself* (Codex, Claude Code, Cursor, etc.) may process code under **its own provider's terms**. That is separate from Vibe Monitor's own upload behavior.

## What you gain

- **Evidence before alerts:** architecture pressure, coupling, module responsibilities and tests.
- **Practical priorities:** what to improve now, what to leave alone and when to reassess.
- **Historical perspective:** how architectural signals evolve across coding sessions.
- **Low overhead:** local structural scans do not call an LLM; optional Agent-assisted interpretation may use tokens.

Vibe Monitor scans project code read-only. **Installation** registers supported Agent MCP/rules configuration and may create local history/backups. No separately installed always-on monitoring daemon is required.

## Documentation

[Official installation and verification](docs/INSTALL.md) · [Agent evaluation/report protocol](docs/AGENT_EVALUATION.md) · [Illustrative architectural scenarios](docs/EXAMPLES.md) · [Security](SECURITY.md) · [Telemetry/privacy](docs/governance/TELEMETRY_PRIVACY_V1.md) · [Website](https://vibe.fde.fan)

### Open source

The unified client is Apache-2.0 licensed and publicly auditable here. Signed Cloud policy/scoring configuration is a separate proprietary service; policy delivery does not grant permission to upload raw source or execute arbitrary remote code. Official release provenance: [GitHub Releases](https://github.com/tubban1/vibe-monitor/releases) and [npm `@vibe-monitor/setup`](https://www.npmjs.com/package/@vibe-monitor/setup).