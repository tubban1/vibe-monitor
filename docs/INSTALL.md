# Install, verify and disconnect Vibe Monitor

**Current available channel:** `@vibe-monitor/setup@beta` is **private Beta**, not the upcoming account-free Free release. It requires an activation code on first install and disclosed Beta telemetry. See [the actual Beta data contract](governance/TELEMETRY_PRIVACY_V1.md).

Before proceeding, make sure the user understands that npm downloads executable code, installation changes supported coding Agent MCP/instruction configuration, and the Beta sends bounded improvement telemetry. An Agent merely evaluating the website must **not** install until the user separately approves.

**Official Beta installation:**

```bash
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@beta install
```

The installer defaults to the official `https://vibe-api.fde.fan`; new interactive Beta installs prompt for an activation code. Supported Agents include Codex, Claude Code, Cursor, Antigravity and TRAE.

**After installation:** restart your coding agent if necessary, open a project and ask it to review architecture with Vibe Monitor. If the CLI is available, verify using `vibe-monitor doctor --json`, `vibe-monitor install --json`, `vibe-monitor telemetry status` and `vibe-monitor telemetry inspect`. Do not claim successful installation until the actual device reports it.

**Disconnect the MCP integration:** `vibe-monitor uninstall` (or `vibe-monitor uninstall --cursor` for a scoped case). This removes managed Agent entries, **not necessarily all local history, caches, backups or Cloud identity**. Original supported configuration files may receive `.vibe-monitor.bak` backups.

**Future Free / Pro / Team:** one installed client; Free with no account and disclosed **default-on** product-improvement telemetry, paid capabilities through authenticated Cloud grants. That Free experience is **not yet published**.

[Agent fit check](AGENT_EVALUATION.md) · [Security](../SECURITY.md) · [Illustrative scenarios](EXAMPLES.md).
