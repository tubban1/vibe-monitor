# Vibe Monitor 1.0.1 release audit — 2026-10-19

**Current decision: NO-GO until the remaining P0 gates below are closed.**

There is one client package, @vibe-monitor/setup, for all plans. The only current stable release target is **1.0.1**. The withdrawn 1.0.0 package is not part of the release path.

## Verified

- macOS Codex native Playground scan passed with signed architecture policy Revision 2 and matching Neon telemetry evidence.
- Windows Antigravity Playground architecture-change test passed; build and lint passed.
- GitHub-hosted Windows, macOS and Ubuntu Node 22 release CI passed on the audited release branch.
- Production OTA uses a dedicated Ed25519 signing root, separate from architecture-policy signing. The client pins only the public key.
- Neon vibeupdate reports signerReady=true with the pinned key fingerprint.
- Production stable release_control remains disabled with rollout 0% and no active stable artifact.
- Real-format npm tarball UAT passed in isolation: SHA-256 verification, Ed25519 positive/negative cases, actual npm install, next-launch activation, rollback, and tampered-artifact quarantine.
- The genuinely published 0.3.0-beta.41 package was downloaded from npm Registry and its registry integrity was verified in isolated QA.
- Public installer handoff tests preserve Beta project history and keep exactly one Agent MCP entry after a verified migration.
- The current release tree contains only the 1.0.1 stable release path; obsolete prerelease bridge naming has been removed.

## Remaining P0 gates

1. **Beta.41 -> 1.0.1 direct migration is still incomplete.** The public 1.0.1 installer can verify an already-active Stable handoff, but it does not itself perform the Beta prepare/activate exchange. The production `POST /migration/beta/verify` route currently returns HTTP 404. Complete the direct one-client migration path, deploy the gated service, then run a real Beta.41 end-to-end UAT.
2. **npm Registry hygiene is not release-ready.** `beta` points to `0.3.0-beta.41`, but `latest` still points to historical `0.0.0-stage`. This QA machine has no npm write authentication, so that tag could not be removed here. Remove/deprecate the staging default before publishing 1.0.1.
3. **Telemetry install behavior is inconsistent across audited sources.** The public 1.0.1 release branch currently initializes telemetry enabled on first install, while the current internal audited source initializes it disabled until explicit `--accept-telemetry` / `telemetry on`. Pick one product contract and make source, disclosure, tests and Cloud behavior identical before release.
4. **The immutable npm `@vibe-monitor/setup@1.0.1` artifact does not exist yet.** Final production manifest verification against the real Registry tarball, exact digest and signer therefore remains pending.
5. **Native exact-artifact upgrade acceptance remains:** Beta.41 -> 1.0.1 on supported macOS/Windows/Linux, plus a signed stable-to-stable update/restart/rollback test from 1.0.1.
6. **Beta.41 vs 1.0.1 scoring/calibration differences still need an explicit product decision** (accept as intended improvement or correct before release).

Final publication additionally requires owner/privacy GO, exact reviewed commit SHA/provenance, npm authorization and an explicit release action.

## Release invariants

- No new Beta version is introduced as a migration bridge.
- Beta.41 goes directly to 1.0.1.
- One npm package and one Vibe Monitor MCP entry per Agent.
- Old Beta credentials are never reused as the Stable credential.
- Project history remains local and preserved through migration.
- Executable updates require a valid signed manifest, immutable registry URL/digest, anti-downgrade checks, and failure rollback.
- Production rollout stays 0% until an explicit release GO.
