# Official MCP Registry publishing

The local stdio server is named `io.github.tubban1/vibe-monitor`. Its `server.json` references the public npm client and passes the required `mcp` argument. Node.js 22+ is required.

This metadata does **not** mean the server is listed. The npm package version referenced by `server.json` must already contain the matching `mcpName` field. Updating this Git repository cannot modify an already-published immutable npm package.

For each approved stable release:

1. Keep `mcpName` in `package.json`. Update both version fields in `server.json` to match the stable version in `package.json`.
2. Follow the existing release audit and approval gates and publish through the existing stable release workflow. If that npm version already exists without `mcpName`, prepare the next approved stable version; never overwrite or reuse the existing npm version.
3. Verify the published package version, `mcpName`, repository, and stdio startup argument. A matching Git source version alone is insufficient.
4. Install the official `mcp-publisher` CLI, then run `mcp-publisher validate`, `mcp-publisher login github`, and `mcp-publisher publish` from the repository root. The GitHub account must own the tubban1 namespace.
5. Query `https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.tubban1/vibe-monitor` and retain the matching returned name and version as publication evidence.

The official registry describes an exact npm release. Repeat these steps when publishing a new stable version; it does not automatically track npm's `latest` tag. Directory entries using `@latest` have a different update policy.

Source analysis is local and read-only. Bounded pseudonymous telemetry defaults ON; opting out pauses Free architecture analysis. See the canonical installation and privacy docs for details. Listing the server does not change that behavior.

Official documentation: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx
