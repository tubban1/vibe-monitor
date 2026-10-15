# Vibe Monitor — Security & Privacy

**Your code stays yours.**

Vibe Monitor analyzes your project locally. Your source code, prompts, and project files are never uploaded to our servers.

Cloud connectivity delivers architecture policies and supports privacy-conscious product improvement.

[Privacy & Data Practices](https://github.com/tubban1/vibe-monitor/blob/main/docs/governance/TELEMETRY_PRIVACY_V1.md)

## Security boundaries

- **Read-only project analysis:** scanning does not rewrite project source. Installing does change supported Agent MCP/rules configuration; scoped backups are implemented for existing files.
- **Current private Beta data practices:** participation requires disclosed telemetry. This sends limited, pseudonymized architecture, usage, performance and outcome signals—not source code, diffs, prompts, secrets, raw paths, filenames or raw logs. The [exact contract](docs/governance/TELEMETRY_PRIVACY_V1.md) explains the fields, local inspection and controls. Cloud policy delivery and telemetry collection are separate functions.
- **Future plans:** Free, Pro and Team will share a client, but future-release telemetry terms are not the current Beta contract. They will be disclosed when released.
- **Agent host is separate:** a user's Codex/Claude/Cursor/ChatGPT may process code the user authorizes that Agent to inspect under the Agent provider's own data policy. Vibe Monitor's no-source-upload statement refers to Vibe Monitor's servers, not third-party Agent providers.
- **No separately installed always-on daemon:** the integration runs in Agent-driven MCP sessions; automatic calls depend on the Agent host and are not guaranteed.
- **Uninstall scope:** `vibe-monitor uninstall` disconnects managed Agent integration, not necessarily every local cache/history file, backup or remote record. A complete-purge claim is **not** supported yet.

[User-approved preinstall fit check](docs/AGENT_EVALUATION.md) · [Install/verify/uninstall](docs/INSTALL.md).

Do not report secrets or exploitable details in public issues; contact the maintainer privately.
