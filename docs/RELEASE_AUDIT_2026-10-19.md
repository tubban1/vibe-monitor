# Vibe Monitor 1.0.1 release audit — 2026-10-19

Current decision: RELEASE CANDIDATE READY. Owner authorized publication; final GitHub CI and OIDC publication remain.

There is one client package, @vibe-monitor/setup, for all plans. The only stable release target is 1.0.1. No Beta.42 or intermediate migration release exists.

## Verified

- Public 1.0.1 source: 71/71 automated tests PASS, build PASS, public surface/privacy audit PASS.
- npm dry-run package: version 1.0.1, six-file allowlist only, 143,523 bytes in the final local dry-run.
- Beta.41 migrates directly to 1.0.1. The stable installer performs prepare -> activate -> verify, preserves project history and keeps one MCP entry.
- Production migration endpoints prepare, activate and verify are live and fail closed: unauthenticated probes return HTTP 401, not 404/503.
- Telemetry behavior is aligned: first install defaults OFF and requires explicit --accept-telemetry before architecture analysis is enabled.
- Production OTA uses a dedicated Ed25519 signing root. The production signer reports ready with the client-pinned fingerprint.
- Real npm-format tarball UAT passed: signature verification, SHA-256, actual npm install, next-launch activation, rollback and corrupted-artifact quarantine.
- Published 0.3.0-beta.41 registry artifact integrity was independently verified.
- Stable updater path is Beta.41 -> 1.0.1 -> future stable; anti-downgrade and rollback tests pass.
- Obsolete Beta.42 and Free-v1 naming and branches were removed.
- Neon QA branches were cleaned; only production main remains.
- Beta.41 vs 1.0.1 score differences are accepted as the intended stable calibration change, not parser/data loss.

## Publication gates

1. Final 1.0.1 commit must pass GitHub Windows, macOS and Ubuntu CI.
2. Merge that exact reviewed commit to public main.
3. Publish @vibe-monitor/setup@1.0.1 through GitHub OIDC Trusted Publishing with provenance.
4. Confirm npm latest equals 1.0.1 and create the GitHub Release from the same SHA.
5. Compute the exact Registry tarball SHA-256, issue the signed stable update manifest, verify it through the public gateway, then enable controlled stable rollout.

## Release invariants

- One package and one Vibe Monitor MCP entry per Agent.
- Beta.41 goes directly to 1.0.1.
- No Beta.42 and no intermediate public migration package.
- Telemetry is explicit opt-in at install.
- Old Beta credentials are not reused as the Stable credential.
- Project history remains preserved through migration.
- Executable updates require a signed manifest, immutable Registry URL/digest, anti-downgrade checks and rollback.
