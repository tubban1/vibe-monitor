# Vibe Monitor 1.0.2 release audit — 2026-10-19

Status: PUBLISHED. Single open-source Free/Pro/Team client. No Beta.42 or Free-v1 edition.

## Published artifacts and source

- Public release commit: f279c6d069b4c8d3704e72295448459c4a75ed79, PR #17 merged.
- npm: @vibe-monitor/setup@1.0.2, dist-tag latest, official GitHub OIDC Trusted Publishing.
- GitHub Release: https://github.com/tubban1/vibe-monitor/releases/tag/v1.0.2, with tarball and release.sha256.
- npm tarball SHA256: 50ac6cf73f3a34c32f1e49bb530ecc5f326a1b8fc983c8c1dcabb8258cf47da5, npm SHA512 integrity verified.
- Windows/macOS/Ubuntu Node 22 release source CI passed. Local public client tests 73/73; build, six-file package allowlist and npm audit (zero production vulnerabilities) passed.
- Publishing succeeded; the immediate Registry dist-tag check failed during propagation, but an independent Registry check confirms latest=1.0.2. The skipped GitHub Release step was manually completed against the same npm tarball and exact source SHA.

## Production cloud, website and signing

- Neon Function deployment 32 active; three additive reporting views for installation attempts, update attempts and lifecycle summary.
- Live production telemetry intake smoke: three test stage events accepted, observed in all reporting views, then exact test rows removed (zero test residues). No Beta or real-user history was deleted.
- Website universal Agent install prompt and bilingual npm paths use @latest, not @beta; internal PR #83 merged, Vercel production is READY, and the live website has been verified.
- The client no longer displays the Cloud Connected installation-success row (applies to 1.0.2, not immutable Beta.41).
- The independent production signer fingerprint matches the client trust root; live signed update manifest verifies for the exact npm tarball.
- OTA began at 0% for signing verification and is currently at a controlled 10% canary (monotonic signed revision 2).
- An isolated 1.0.2 npm-format tarball test verified download, SHA256, signature, real npm runtime install, next-start activation, rollback and corrupt-archive quarantine.

## Data limitations and safe user choices

- First installs default to disclosed pseudonymous telemetry ON. --no-telemetry, local telemetry off/on, and preserved reinstall opt-out work. Web-based per-device settings are still planned, not shipped.
- Install stage and update stage telemetry is best effort; offline or force-killed processes can create gaps, which must not be misreported as success/failure.
- Uninstall here means integration removal, not proven deletion of every file. Manual filesystem deletion and inactivity cannot prove uninstall.
- Production data region is AWS Singapore. Local telemetry shutdown stops new transmissions but does not erase already accepted remote history.
- Controlled OTA at 10% is not a completed full-fleet rollout, and actual Beta.41 auto-migration on personal Windows/macOS installations has not been freshly revalidated.

## Links

- https://github.com/tubban1/vibe-monitor/pull/17
- https://github.com/tubban1/vibe-monitor-internal/pull/82
- https://github.com/tubban1/vibe-monitor-internal/pull/83
