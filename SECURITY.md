# Vibe Monitor — security, local code analysis and telemetry

## Source-code privacy — verifiable in public code

**Vibe Monitor does not upload source code to its servers.** Source files, code diffs, prompts, project names/paths, credentials, secrets and raw logs are excluded from the product telemetry wire format. Its actual source scan runs locally. Rather than relying only on this statement, verify:

- `src/telemetry.js`: narrow event schema and `freeTelemetryWireBatch` projection.
- `src/telemetry-quality.js`: allowlisted fields and projection quality checks.
- `src/cloud.js`: bounded `/free/telemetry` network submission.
- `test/oss-lifecycle-telemetry.test.js` and other telemetry contract tests for redaction and opt-out.

This statement covers **Vibe Monitor's own telemetry and network upload path**. A separate coding Agent may transmit files or context to its model provider under that provider's settings and terms; do not conflate the two.

## Current stable release behavior

- **Official release:** `@vibe-monitor/setup@latest`; the public client supports the Free/Pro/Team model.
- **Scanning:** source inspection is read-only; installing or disconnecting Vibe Monitor may update managed coding Agent MCP/rules settings, with scoped backups.
- **Product telemetry:** bounded pseudonymous installation/architecture/use events default ON on fresh installs, not code. Use `--no-telemetry` or `vibe-monitor telemetry off` to stop; Free analysis pauses. A previous opt-out persists. Accepted historical Cloud data is not retroactively deleted by a local opt-out.
- **Storage:** the telemetry intake currently uses Neon AWS Singapore; installation/project pseudonyms may count as personal data. See [current privacy contract](docs/governance/TELEMETRY_PRIVACY_V1.md).
- **Policy delivery:** signed declarative architecture scoring rules, not arbitrary remotely executed code.
- **Runtime:** Agent-invoked MCP workflow, not a separately installed permanent daemon.
- **Removal:** `vibe-monitor uninstall` removes managed Agent integration, not necessarily every local history file, backup or already retained Cloud record.

Read [installation guide](docs/INSTALL.md) or use the [automatic Agent code-project evaluation](docs/AGENT_EVALUATION.md). Never disclose sensitive security issues or credentials in public issues; contact maintainers privately.
