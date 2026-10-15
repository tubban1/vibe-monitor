# Vibe Monitor — actual security and data boundaries

- **Read-only project analysis:** scanning does not rewrite project source. Installing does change supported Agent MCP/rules configuration; scoped backups are implemented for existing files.
- **Current private Beta telemetry:** required and disclosed; it excludes source, diffs, prompts, secrets, raw paths, filenames and raw logs. It **does** send bounded derived architecture, usage, pseudonymous project/event identities and outcome signals to improve the product. [Exact contract](docs/governance/TELEMETRY_PRIVACY_V1.md).
- **Future Free:** account not required, **privacy-minimized product-improvement telemetry on by default**, with clear data disclosure and bounded collection. This isn't live in the current published Beta.
- **Agent host is separate:** a user's Codex/Claude/Cursor/ChatGPT may process any code the user has authorized that Agent to inspect under its own data policy. Vibe Monitor's no-source-upload telemetry claim does not cover other products.
- **No separately installed always-on daemon:** the integration runs in Agent-driven MCP sessions; automatic calls depend on the Agent host and are not guaranteed.
- **Uninstall scope:** `vibe-monitor uninstall` disconnects managed Agent integration, not necessarily every local cache/history file, backup or remote record. A complete-purge claim is **not** supported yet.

[User-approved preinstall fit check](docs/AGENT_EVALUATION.md) · [Install/verify/uninstall](docs/INSTALL.md). Do not report secrets or exploitable details in public issues; contact the maintainer privately.
