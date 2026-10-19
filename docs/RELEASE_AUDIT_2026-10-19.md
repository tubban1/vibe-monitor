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

1. **Beta.41 → 1.0.1 direct migration is not yet proven end-to-end with a real eligible Beta installation and the live gated migration service.** The server-side prepare/activate/verify components and public takeover validation exist, but the complete user flow still needs production-like UAT without creating another Beta release.
2. **The actual immutable npm @vibe-monitor/setup@1.0.1 registry artifact has not been published**, so the final production signed-manifest download cannot yet be verified against the real registry object.
3. **Three-OS native upgrade acceptance still needs the exact release artifact**: Beta.41 → 1.0.1 and 1.0.1 → a later signed stable candidate, including restart activation and rollback.
4. **Website telemetry controls require end-to-end validation** against an individual installation before the README can claim that users can manage collection there.
5. **Beta.41 vs 1.0.1 scoring/calibration differences require explicit product acceptance or correction**; functional coverage is present, exact numerical parity is not established.
6. Final owner GO, privacy GO, exact reviewed commit SHA, provenance, and npm release workflow approval are required before publication.

## Release invariants

- No new Beta version is introduced as a migration bridge.
- Beta.41 goes directly to 1.0.1.
- One npm package and one Vibe Monitor MCP entry per Agent.
- Old Beta credentials are never reused as the Stable credential.
- Project history remains local and preserved through migration.
- Executable updates require a valid signed manifest, immutable registry URL/digest, anti-downgrade checks, and failure rollback.
- Production rollout stays 0% until an explicit release GO.
