# Vibe Monitor

> [!WARNING]
> **1.0.2 release candidate.** The published stable remains 1.0.1 until Trusted Publishing completes. Beta.41 migrations use the verified direct-to-stable bridge.

> [!NOTE]
> **1.0.2 candidate (2026-10-19).** Local lifecycle diagnostics and consent changes are being verified. The older 1.0.1 npm artifact cannot be overwritten.

**AI 写代码很快，屎山也可能堆得很快。Vibe Monitor 帮你在失控前发现问题。**

**AI ships code fast. It can build spaghetti code even faster. Vibe Monitor helps your coding agent spot architectural trouble before it gets expensive.**

A **read-only project architecture advisor for the coding agent you already use**, not another IDE and not a machine for flooding you with warnings.

- **What's getting harder to change?** Identify concrete pressure in your project's structure and change history.
- **What should I do next?** Get a practical next step—and learn what **not** to over-engineer.
- **Did it actually help?** Track what improved or got worse across coding sessions.

> **Illustrative advice format (not a real scan):** “This file mixes UI and storage changes. Before adding another feature, separate the storage interaction. **Don't split into microservices yet**; the evidence doesn't justify that complexity.”

**Your code stays yours.**

Vibe Monitor analyzes your project locally. Your source code, prompts, and project files are never uploaded to our servers.

Cloud connectivity delivers architecture policies and supports disclosed product-improvement telemetry.


[Privacy & Data Practices](https://github.com/tubban1/vibe-monitor/blob/main/docs/governance/TELEMETRY_PRIVACY_V1.md)

🌐 [Website](https://vibe.fde.fan) · [Ask your Agent to evaluate Vibe Monitor](docs/AGENT_EVALUATION.md) · [Security and privacy](SECURITY.md)

## Ask your coding agent first

Copy this into Cursor, Claude Code, Codex, Antigravity, or another agent:

> Look at https://vibe.fde.fan and https://github.com/tubban1/vibe-monitor. Explain what Vibe Monitor really does, its limitations, security, data collection, and installation. If you have filesystem access, **ask me which project you may inspect**. With my permission, inspect only that project **read-only** and identify one or two real architecture or workflow pain points from evidence. Tell me honestly whether Vibe Monitor would help, or why I don't need it. Don't install or execute downloaded software, change files, or upload project data without my approval.

[Full Agent evaluation flow and report template →](docs/AGENT_EVALUATION.md)

## Installation

The stable package is @vibe-monitor/setup@1.0.1. The published 1.0.1 package requires `--accept-telemetry`. A subsequent patch is being prepared to enable basic telemetry by default on fresh installs, with `--no-telemetry` available and prior opt-outs preserved. Existing Beta.41 users can use the published package with install --migrate-beta --accept-telemetry; no intermediate Beta release is required.

### Architecture policies

The client scans source locally and accepts signed architecture-scoring and guidance rules from `GET https://vibe-api.fde.fan/free/policy`. It retains a small local fallback. Proprietary rules stay on the private Cloud side; the client never executes arbitrary remote code.

### Product telemetry

Telemetry collects bounded pseudonymous product and architecture events, not source code, paths, prompts or credentials. Starting with 1.0.2, first installs default ON with disclosed --no-telemetry opt-out, and local telemetry off/on is available. Opt-out survives reinstalls and pauses Free analysis. Website device-level settings are not yet available.

Product events are uploaded separately through `POST /free/telemetry` only when the production gateway and Neon intake are enabled. This intake has independent rate-limiting, bounded payload validation and an origin shared secret; a successful policy fetch does not imply telemetry acceptance. Unsigned or unavailable Cloud policy falls back to the minimal local rules.

The signed Cloud strategy and telemetry intake were verified live on 2026-10-18. The audited 1.0.1 path writes sanitized product events into the existing public.events model without moving Beta history. Cloud telemetry records have no automatic TTL or scheduled purge; scoped legal erasure requires a separate auditable process. The database is in AWS Singapore. Linkable pseudonymous identifiers may qualify as personal data; privacy approval for public release remains a separate gate.

[Privacy & Data Practices](docs/governance/TELEMETRY_PRIVACY_V1.md)

## What happens to your code and computer?

| Concern | Verified behavior / limit |
| --- | --- |
| Read-only code analysis | Project source is analyzed without rewriting it. **Installing does modify managed Agent MCP/rule configuration.** |
| No source-code upload in product telemetry | Source, diffs, prompts, secrets, paths and filenames are not uploaded by default telemetry. Coarse architecture, usage and outcome signals **are** sent under the disclosed contract. |
| No extra always-on daemon | Designed around Agent MCP sessions and checkpoints; not a separately installed permanent monitoring daemon. Invocation depends on the host Agent. |
| Backup and undo | Supported configuration files use scoped backup/managed-block mechanisms. `uninstall` removes managed Agent integration; it does **not** guarantee deletion of all local history or backups. |

[Detailed security boundaries →](SECURITY.md) · [Practical scenarios →](docs/EXAMPLES.md)

## Is Vibe Monitor open source?

Yes. The client is Apache-2.0 and its source is in this public repository. Its proprietary cloud scoring configuration is separate and signed. This repository contains the single unified client, not separate Free, Pro or Team installers. Stable npm distribution and provenance are controlled by the official GitHub Actions release workflow.
