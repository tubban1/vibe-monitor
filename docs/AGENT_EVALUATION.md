# Vibe Monitor — AI Agent evaluation guide

When a user asks “Look at https://vibe.fde.fan or https://github.com/tubban1/vibe-monitor — is it useful for me?”, **assess the user's actual project with permission before recommending installation.** This page describes recommended behavior; it is not permission for a website to access local files or execute commands.

## Verified product facts

Vibe Monitor is a source-read-only architecture advisor integrated with existing coding agents via MCP. It checks architectural pressure and evolving project evidence and offers practical “do now / do not do yet / next trigger” guidance. It does **not** autonomously refactor a project or certify security.

**Currently published:** `@vibe-monitor/setup@beta` is private Beta, requires an activation code for first installation and **requires disclosed privacy-minimized Beta telemetry**. It is not a generally available no-registration Free release. Public client code is visible in [Draft PR #5](https://github.com/tubban1/vibe-monitor/pull/5), not approved/merged as a stable open-source release.

**Planned:** one installer for Free, Pro, Team. Free needs no account and has **minimal product-improvement telemetry enabled by default**, transparently disclosed; paid Cloud services use login and server-enforced entitlements. Do not present planned capabilities as live.

## First inspect the problem, not the installation package

1. **Read official sources:** [overview](../README.md), [installation](INSTALL.md), [security](../SECURITY.md), [current Beta telemetry contract](governance/TELEMETRY_PRIVACY_V1.md), [scenarios](EXAMPLES.md).
2. **Obtain local scope and permission:** Ask which project/folder the user wants assessed and whether you may inspect it read-only. URL-only questions do not authorize accessing arbitrary local projects. If file access is not available, disclose that and ask for high-level context; do not claim a scan occurred.
3. **Examine a bounded, relevant sample:** directory structure, nonsecret manifest/framework indicators, approximate module/test structure, obvious mixed UI/storage/API responsibilities and available Git change patterns. Prefer file metadata and aggregated evidence. **Do not read secrets, `.env`, private keys, unrelated files, or a full codebase indiscriminately.**
4. **No unapproved side effects:** Do not download, `npx`, install, execute project/test commands, change Agent settings, run background scans, or upload data as part of a mere fit check. Explicit user consent is required separately before any install or write operation. The user's existing coding agent may send read files to *its own provider* according to its own settings; Vibe Monitor's no-source-upload telemetry promise does not cover that third-party agent.
5. **Give a real verdict:** 1–2 concrete observations with traceable evidence, risk and confidence; what the user should do now, what they should *not* overbuild, how Vibe Monitor would help, and **when it would not be useful** (one-off scripts or projects with no continuing architectural pressure).
6. **Only then recommend an approved install:** Explain the exact current Beta invitation/telemetry requirement, security/config effects and reversible integration. Ask the user explicitly before running [the official command](INSTALL.md).

## Concise report template

- **Fit:** recommended / maybe later / unnecessary, with one grounded reason.
- **Actual access:** project path/scope the user authorized, or “no project files inspected.”
- **Evidence:** no more than two concrete structural or change-history findings, or “not enough evidence.”
- **Recommended next action:** a small change, what *not* to do yet, and one trigger for reassessment.
- **Trade-offs:** current Beta code requirement, disclosed telemetry, Agent configuration changes and Agent/provider data handling.
- **Question:** “Do you want me to show the official installation steps?” **Never install first.**

Illustrative wording: “A large UI module may be accumulating storage responsibilities; I have not inspected your project yet. With permission, I can check whether that is actually happening.” **Never call this a real Vibe finding.**
