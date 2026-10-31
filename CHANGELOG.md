# Changelog

All notable changes to the Vibe Monitor client are documented in this file.

## [1.0.12] - 2026-10-23

### Added
- **Stage Demotion Hysteresis (降级缓冲)**:
  - Findings already at $S_k$ ($k \ge 3$) now require score drops below `Sk threshold - demotionMargin` (default 5 points, configurable via signed decision policy in range 0–15) before demoting to a lower stage.
  - Substantive signal reductions (supporting signals dropping below the stage minimum) continue to demote immediately without buffer.
  - Promotion rules remain unchanged.
  - Mitigates flapping/oscillation near stage thresholds (e.g., 48–52) observed in production data, improving finding stability.
  - Telemetry transition events now record `demotionMargin` in payload and wire projection.

### Fixed
- **MCP Filesystem Root Workspace Rejection (Antigravity IDE 修复)**:
  - Implicit MCP workspace selection now explicitly rejects filesystem root (`/`), IDE application directories, and unconfirmed working directories, preventing false-positive whole-system scans and "scanning temporarily unavailable" errors in Antigravity IDE.
