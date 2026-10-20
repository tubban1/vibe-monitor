# Official MCP Registry publishing

The local stdio server is named `io.github.tubban1/vibe-monitor`. Its `server.json` references the public npm client and passes the required `mcp` argument.

This metadata does **not** mean the server is listed. The npm package version referenced by `server.json` must already contain the matching `mcpName` field. The published 1.0.5 package does not contain that marker, so the manifest in this change cannot be published yet.

For the next approved stable release:

1. Follow the existing release audit and approval gates; do not republish immutable npm 1.0.5. Keep the `mcpName` marker in the package metadata.
2. Update both `version` fields in `server.json` to that new stable version, and publish the npm package through the existing stable release workflow.
3. Verify the npm version, `mcpName`, repository, and stdio startup argument. Requires Node.js 22+.
4. Install the official `mcp-publisher` CLI, then run `mcp-publisher validate`, `mcp-publisher login github`, and `mcp-publisher publish` from the repository root. The GitHub account must own the tubban1 namespace.
5. Query `https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.tubban1/vibe-monitor` and retain the matching returned name and version as publication evidence.

Source analysis is local and read-only. Bounded pseudonymous telemetry defaults ON; opting out pauses Free architecture analysis. See the canonical installation and privacy docs for details. Listing the server does not change that behavior.

Official documentation: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx
