# dash-mcp

An improved [Model Context Protocol](https://modelcontextprotocol.io/) server for [Dash](https://kapeli.com/dash), the macOS documentation browser.

**Requires Dash 8** — download from https://blog.kapeli.com/dash-8

---

## Quick start

### Install

```bash
npm install          # local development
npm install -g .     # install the dash-mcp CLI globally from this checkout
```

The published/GitHub-installed CLI runs the TypeScript source via `jiti`, so `dist/` is not required at runtime.

### Local use (stdio — single client)

```json
// In Claude Desktop / Claude Code config:
{
  "mcpServers": {
    "dash": {
      "command": "dash-mcp",
      "args": ["--transport", "stdio"]
    }
  }
}
```

### LAN use (HTTP — multiple machines)

Start the server once on your Mac:

```bash
dash-mcp --transport streamable-http --host 0.0.0.0 --port 8000
```

Then configure clients (local and remote):

```json
{
  "mcpServers": {
    "dash": {
      "transport": "streamable-http",
      "url": "http://192.168.x.x:8000/mcp"
    }
  }
}
```

- **Local Mac**: use `http://127.0.0.1:8000/mcp`
- **Other LAN machines**: use `http://YOUR_MAC_IP:8000/mcp`

After calling `setup_dash`, documentation URLs are proxied through a random free port such as `http://YOUR_MAC_IP:57464/...` so remote browsers can open them directly. `setup_dash.proxyUrl` and search result `load_url` values include the actual assigned port. Use `--proxy-port 16766` if you want a fixed proxy port.

---

## Tools

### `setup_dash` *(openWorldHint)*

Initialises Dash and its API server. **Must be called before any other tool.**

In HTTP mode, also starts a reverse proxy on `--proxy-port` (default `0`, meaning a random free port) that forwards Dash documentation content to the LAN.

```json
// Response
{
  "success": true,
  "dashApiUrl": "http://127.0.0.1:51620",
  "contentServerPort": 60876,
  "proxyPort": 57464,
  "proxyUrl": "http://192.168.1.100:57464",
  "message": "Dash API ready ..."
}
```

---

### `list_installed_docsets` *(readOnlyHint)*

Lists all docsets installed in Dash. Results are truncated at 25 000 tokens with `truncated`, `truncatedCount`, and `truncationNotice` fields.

---

### `search_documentation` *(readOnlyHint)*

Searches documentation and code snippets.

```json
// Input
{
  "query": "sort",
  "docsetIdentifiers": ["ruby", "python"],  // ← array, not comma-separated string
  "searchSnippets": true,
  "maxResults": 50
}

// Response
{
  "results": [...],
  "truncated": false,
  "warning": "FTS not enabled for this docset",  // ← separate from error
  "error": null
}
```

In HTTP mode, `load_url` values are rewritten to point to the proxy so remote browsers can open them.

---

### `load_documentation_page` *(readOnlyHint)*

Loads a documentation page from a `load_url` returned by `search_documentation` and converts it to Markdown. Accepts both direct Dash URLs and proxy-rewritten URLs.

---

### `enable_docset_fts` *(idempotentHint)*

Enables full-text search for a docset. Returns a structured result instead of a bare boolean:

```json
// Success
{ "success": true, "identifier": "python" }

// Failure
{ "success": false, "identifier": "typo", "error": "Docset 'typo' not found. Run list_installed_docsets ..." }
```

---

## CLI options

| Flag | Default | Description |
|---|---|---|
| `--transport` | `stdio` | `stdio` or `streamable-http` |
| `--host` | `0.0.0.0` | Bind address (HTTP mode) |
| `--port` | `8000` | MCP server port (HTTP mode) |
| `--proxy-port` | `0` | Dash content proxy port (HTTP mode); `0` means a random free port, or pass a fixed port like `16766` |

---

## Development

```bash
npm test          # vitest unit tests
npm run build     # tsc compilation
npm run dev       # tsx src/index.ts (no build needed)
```

---

## Requirements

- macOS (Dash is macOS-only)
- [Dash 8](https://kapeli.com/dash)
- Node.js ≥ 18
