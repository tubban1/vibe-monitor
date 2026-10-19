# Vibe Monitor — telemetry and privacy contract (stable 1.0.2)

Current customer-facing policy for the unified open-source client. Last reviewed: 2026-10-19. Earlier version-specific release data remains in separate historical audits.

## Source stays local

**Vibe Monitor never uploads raw source code, diffs, prompts, repository names, raw file/project paths or secrets to Vibe Monitor servers.** The analysis runs locally. You can audit the [telemetry serialization](../../src/telemetry.js), [field validation](../../src/telemetry-quality.js), [network send path](../../src/cloud.js) and [tests](../../test/oss-lifecycle-telemetry.test.js) in this public repository.

This is a claim about *Vibe Monitor's own product data path*, not the policies of separate coding Agents or model providers that may read project context.

## What product telemetry actually sends

The following **derived / bounded / pseudonymous** information may be transmitted while enabled:

- Random installation, session, call and attempt identifiers, event names, timestamps, client version and coding-Agent family.
- HMAC-pseudonymized project and finding identifiers; broad source-file/LOC bucket counts, bounded structural signals, finding family/stage and coarse outcome observations.
- Product health, installation stage and error codes, actual Agent-integration removal events and bounded OTA stage/result codes.
- No source text, diff, prompt, chat content, free-form logs, private file names, full paths, repository URLs or secrets.

The outbound telemetry uses an allowlisted JSON wire projection and server-side validation rather than forwarding arbitrary source scan objects.

## Defaults and user control

For the released `1.0.2` client, new installs disclose that bounded product telemetry defaults **ON**. Disable via `install --no-telemetry` or `vibe-monitor telemetry off`. Inspect via `vibe-monitor telemetry status` and `vibe-monitor telemetry inspect`. `vibe-monitor telemetry on` resumes collection. An opt-out choice remains OFF after reinstall unless changed explicitly.

Current Free analysis requires telemetry service availability; turning telemetry OFF pauses Free analysis. Missing network uploads never authorize falsely reporting an event as delivered. Per-device preferences on the website are **not yet available**; until implemented, use local controls.

## Storage, correlation and user privacy

Events may be correlated through stable **pseudonymous IDs**; this data is **not guaranteed anonymous** and may qualify as personal information. Product telemetry is received through `POST https://vibe-api.fde.fan/free/telemetry` and validated by Cloudflare Gateway and Neon intake. Production Neon is in **AWS Singapore (ap-southeast-1)**.

Accepted product history currently has **no automatic age-based Cloud TTL/purge**. A local opt-out stops new uploads but does not erase previously accepted records. Lawful targeted erasure requires a separately authorized process. User-specific website configuration and erasure workflows are not yet shipped; do not imply otherwise.

## Lifecycle interpretation

A completed install or update is recorded only with supporting evidence. A long gap in progress is a **suspected stall**, not a confirmed failure. `uninstall` removes the managed Agent integration, which is **not proof** of deletion of all local files or Cloud history. Offline periods and silent deletion cannot reliably establish uninstalls.

## Open-source verification

Inspect `src/telemetry.js`, `src/telemetry-quality.js`, `src/cloud.js`, `src/install-lifecycle.js` and telemetry tests. Read [security boundaries](../../SECURITY.md). Signed Cloud scoring policy is separate from the open-source client's telemetry code and does not require source-code upload.
