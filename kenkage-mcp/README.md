# kenkage-mcp

An MCP server that exposes [kenkage](https://www.npmjs.com/package/kenkage)'s
on-device DOM + QuickJS engine as agent tools. Real page loading, real DOM
querying, and real (untrusted) JavaScript execution — isolated by
construction, in WASM linear memory, not by a spawned browser process and not
by a DOM shim's best-effort discipline. No headless browser, no server round
trip: kenkage runs directly in this MCP server's own Node process.

## Tools

| Tool | What it does |
|---|---|
| `load_page` | Fetches a real URL, parses it, and runs its classic `<script>` tags against a real DOM. Returns status, title, text, and script execution results. |
| `parse_html` | Parses an HTML string you already have — title, plain text, Markdown, node count. No script execution. |
| `query_selector` | Parses an HTML string and returns the tag + text of every element matching a CSS selector. |
| `eval_js` | Runs JavaScript in the isolated in-WASM QuickJS engine, optionally against a parsed document. Use this instead of evaluating untrusted/model-generated code in your own process. |

Each tool call creates a fresh kenkage engine instance and destroys it when
done — no shared state, no session handles to manage across calls.

## Install

No install step needed beyond pointing your MCP client at it — `npx` resolves
and runs it on demand.

### Claude Code

```sh
claude mcp add kenkage -- npx -y kenkage-mcp
```

### Claude Desktop / other JSON-config clients

Add to your MCP config (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kenkage": {
      "command": "npx",
      "args": ["-y", "kenkage-mcp"]
    }
  }
}
```

## Why a plain, unbundled server

This package is deliberately written as plain ESM with **no bundler, no
build step** — `bin/kenkage-mcp.js` imports `kenkage` and
`@modelcontextprotocol/sdk` directly via normal Node module resolution.
kenkage locates its own `.wasm` file relative to its installed location at
runtime; bundling this server would risk the exact `import.meta.url`
breakage documented in [kenkage's own README](../kenkage/README.md#bundler-consumers).
Running it exactly the way a plain `node script.js` invocation would is the
one environment we've verified has zero friction.

## Notes on network access

`load_page` fetches over this process's real Node network stack — no
browser, no CORS, no sandbox allowlist. It's bound only by what the target
server allows at the network layer (most sites; some block scrapers/bots
outright, which is between you and the target site's own policy, not
something this server can or should override).

## License

MIT — see [kenkage's LICENSE](../kenkage/LICENSE).
