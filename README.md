# Vibe Monitor

**A local architecture advisor for AI coding workflows.** AI agents ship features fast; Vibe Monitor helps you see when architectural complexity is accumulating and what actually needs attention.

## Get started — official stable release

The open-source client is published on npm as **`@vibe-monitor/setup@latest`** (current stable release: **`@vibe-monitor/setup@1.0.8`**). One client is used for Free/Pro/Team; future paid features are not separate installers.

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
