# Vibe Monitor 1.0.2 release audit — 2026-10-19

Status: RELEASE CANDIDATE — NOT YET PUBLISHED.

Scope is a single open-client package for Free/Pro/Team. No Beta.42, no alternate Free distribution, and no intermediate migration package.

## Verified locally
- macOS Node 22.23.3: 73/73 public automated tests PASS, including two new lifecycle regression cases.
- npm build PASS, npm package dry run contains exactly six approved files.
- Official npm Registry production-dependency audit: zero vulnerabilities.
- Website English + Chinese static surface tests: 7/7 PASS on the private website worktree; deployment still pending.
- First-install basic pseudonymous telemetry defaults ON after visible notice; --no-telemetry, CLI off and on are available; a prior opt-out survives reinstallation.
- Stable and private-beta success banner no longer contains the Cloud row in source. Immutable existing Beta.41 cannot be changed retroactively.
- Install attempt journal records coarse-to-fine stages and read-only doctor diagnostics distinguish suspected stall from confirmed failure.
- Best-effort explicit installed and Agent-integration-removed events use the established bounded anonymous-account-free Free telemetry transport. Lack of an event is never proof of uninstall.

## Release blockers requiring evidence
1. Independent GitHub CI for exact 1.0.2 SHA: Windows, macOS and Ubuntu.
2. Production acceptance evidence for 1.0.2 installed/integration-removed events and authorized user choice. End-to-end persistence of install failed/stalled and per-step OTA telemetry is NOT yet proven; do not claim an entire remote lifecycle funnel exists.
3. Fresh product-owner privacy review: stable installation pseudonyms are linkable and the Cloud data region is AWS Singapore; local off does not delete already accepted records.
4. Official npm Trusted Publishing approval, provenance, and exact six-file tarball integrity.
5. Website must switch away from @beta only when a compatible stable package has been published. New website instructions are prepared, not yet production deployed.
6. Only after npm publication: signed OTA manifest, controlled rollout and real Beta.41 migration checks on Mac/Windows.

Uninstall note: removing every Agent integration does not remove the runtime or local history. The client reports integration_removed rather than uninstalled for open-client setup removal.
