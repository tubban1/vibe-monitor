# Install Vibe Monitor — official stable client

The **public stable** release is `@vibe-monitor/setup@latest` (currently version `1.0.2`). One installer serves Free/Pro/Team. No activation code is needed.

## Install

```bash
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@latest install
```

The installer verifies the environment and configures supported coding Agent integration. It may modify **managed MCP and Agent instruction settings** (with scoped backup handling), but not project source code.

**No source-code upload:** Vibe Monitor analyzes source locally and does not transmit source files, diffs, prompts, project paths or credentials to its servers. The bounded pseudonymous product telemetry is ON by default for new installs and disclosed during installation. To opt out at installation time:

```bash
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@latest install --no-telemetry
```

Turning product telemetry OFF pauses the current Free architecture analysis. Prior opt-outs persist across reinstall; the local CLI also supports `vibe-monitor telemetry off` and `vibe-monitor telemetry on`. Website-level individual device preferences are planned, not yet available.

## Verify

Verify the actual installed version, supported Agent MCP integration, `vibe-monitor doctor --json`, `vibe-monitor telemetry status` and one read-only architecture scan in an accessible code project. Do not report success unless installation and integration have really been verified.

## Local maintenance

`vibe-monitor uninstall` disconnects managed Agent integration but does not promise deletion of every runtime file, backup, local history or previously accepted Cloud record. See [security](../SECURITY.md).

For historical version-specific migration, rollback and incident information, consult [release audit records](RELEASE_AUDIT_1.0.2.md); they are not current fresh-install instructions.

[Code project suitability assessment](AGENT_EVALUATION.md) · [Telemetry controls and field list](governance/TELEMETRY_PRIVACY_V1.md).
