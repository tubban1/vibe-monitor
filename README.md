# Vibe Monitor

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

## Try the current Beta

The published `@vibe-monitor/setup@beta` is **private Beta software**, not the future public Free release. New installations currently **require an activation code** and **the disclosed Beta telemetry**. Review the [Beta telemetry contract](docs/governance/TELEMETRY_PRIVACY_V1.md) and obtain a code before running:

```bash
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@beta install
```

The default official Cloud API is `https://vibe-api.fde.fan`. [Installation, verification, error handling and uninstall guide →](docs/INSTALL.md)

**Future direction: one installer, Free / Pro / Team.** Free should work without creating an account, with clearly disclosed **required product-improvement telemetry**: stopping telemetry disables Free analysis. Pro/Team use the *same client* and unlock Cloud services through authentication and server-enforced entitlements. This Free onboarding/telemetry contract is **not shipped in Beta.41**.

**One Free plan, two separate Cloud interfaces:** `GET /free/policy`
delivers signed architecture-analysis strategy **from Cloud to client**;
`POST /free/telemetry` sends bounded pseudonymous product/architecture
signals **from Free client to Cloud**. **Community is an internal signing/profile identifier,
not a subscription tier.** The unpublished historical policy URL has no compatibility alias. Free, Pro and
Team share the same installer. Fetching a strategy never authorizes a
telemetry upload; both channels have independent security checks and
deployment gates. Neither new production endpoint is live yet.

### Planned Free service and telemetry exchange (release gate pending)

The Free service requires product-improvement telemetry covering usage, performance, technical/project categories, architecture change, recommendations, and explicit user or Agent outcome reports. A full scan may contribute coarse inferred product type, technology, deployment, architecture and test classifications and pseudonymous project/finding/outcome links—not raw source, diffs, repository names/URLs, file paths, prompts, credentials or free-form notes.

On Free, `vibe-monitor telemetry off` **stops collection and architecture analysis**; `vibe-monitor telemetry on` restores both. `vibe-monitor telemetry inspect` shows queued events. Free installation and setup reject `--no-telemetry`. Local diagnostics and security inspection and uninstall remain accessible. Pro/Team entitlements require verified Cloud grants; this is not a self-declared premium bypass.

**Not enabled in production:** This source audit still hard-disables Free Cloud uploads. Before official release, the disclosed data categories, lawful basis, regional handling, long-term Cloud preservation, separately audited legally required erasure and any distinct purposes such as model training or sharing need independent legal review plus live technical acceptance. Requiring telemetry to use a service does not by itself establish legal consent.


**Planned long-term Cloud policy for Free/Pro/Team:** accepted telemetry,
architecture evolution, recommendations, feedback and outcome verification
are preserved with no automatic Cloud TTL, scheduled deletion or age-based
purge. Local logs, caches and unsent queues may be cleaned separately for
performance and disk usage. Identifiers remain pseudonymous (not necessarily
anonymous). Lawful scoped erasure is separately authorized and audited.
The current Neon region is AWS Singapore (`aws-ap-southeast-1`), subject to
appropriate international data-transfer notice and safeguards. This is
a release design, not a claim that Free production collection is live or that
legal/data-transfer review has been completed.

## What happens to your code and computer?

| Concern | Verified behavior / limit |
| --- | --- |
| Read-only code analysis | Project source is analyzed without rewriting it. **Installing does modify managed Agent MCP/rule configuration.** |
| No source-code upload in default Beta telemetry | Source, diffs, prompts, secrets, paths and filenames aren't collected by the default telemetry. Coarse architecture, usage and outcome signals **are** sent under the disclosed Beta contract. |
| No extra always-on daemon | Designed around Agent MCP sessions and checkpoints; not a separately installed permanent monitoring daemon. Invocation depends on the host Agent. |
| Backup and undo | Supported configuration files use scoped backup/managed-block mechanisms. `uninstall` removes managed Agent integration; it does **not** guarantee deletion of all local history or backups. |

[Detailed security boundaries →](SECURITY.md) · [Practical scenarios →](docs/EXAMPLES.md)

## Is Vibe Monitor open source?

The **public client-source review is already visible in [Draft PR #5](https://github.com/tubban1/vibe-monitor/pull/5)**. Its source has **not** been merged to `main` or formally released as an approved open-source package. The npm Beta remains privately licensed. Do not confuse a public Draft PR or passing CI with release approval.

The website and proprietary Vibe Cloud live in a separate private repository. Public client, Cloud signing, IP/licensing, Windows release gates, and production service-level entitlements must pass their own reviews before a stable release.

[Request Beta access](https://github.com/tubban1/vibe-monitor/issues/new?template=beta-access.yml). GitHub issues are public: never post activation codes, credentials, private URLs, source files, or logs with sensitive information.
