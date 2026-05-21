#!/usr/bin/env node
/**
 * Entry point. Parses CLI flags, configures state, then starts the MCP server
 * in the requested transport mode (stdio or streamable-http).
 *
 * HTTP mode uses Hono + @hono/node-server (already a transitive SDK dep,
 * so no extra install needed).
 *
 * Usage:
 *   dash-mcp [--transport stdio|streamable-http] [--host 0.0.0.0] [--port 8000] [--proxy-port 0]
 */

import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { serve } from '@hono/node-server';
import type { HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';

import { state } from './state';
import { buildMcpServer } from './server';

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    help:         { type: 'boolean', short: 'h' },
    transport:    { type: 'string', default: 'stdio' },
    host:         { type: 'string', default: '0.0.0.0' },
    port:         { type: 'string', default: '8000' },
    'proxy-port': { type: 'string', default: '0' },
  },
  strict: false,
});

function printHelp() {
  process.stdout.write(`dash-mcp - MCP server for Dash documentation browser

Usage:
  dash-mcp [options]

Options:
  -h, --help                          Show this help message and exit.
  --transport <stdio|streamable-http> MCP transport mode. Default: stdio.
                                      stdio is for local MCP clients that launch the process.
                                      streamable-http starts a long-running HTTP server.
  --host <address>                    HTTP bind address for streamable-http mode. Default: 0.0.0.0.
                                      Use 127.0.0.1 for local-only access.
  --port <0-65535>                    HTTP MCP server port. Default: 8000.
                                      Use 0 to let the OS choose a random free port.
  --proxy-port <0-65535>              Dash documentation reverse-proxy port. Default: 0.
                                      0 lets the OS choose a random free port; setup_dash returns
                                      the actual proxyPort/proxyUrl and search results use it.

Examples:
  dash-mcp --transport stdio
  dash-mcp --transport streamable-http --host 0.0.0.0 --port 8000
  dash-mcp --transport streamable-http --host 0.0.0.0 --port 8000 --proxy-port 16766
`);
}

if (values.help) {
  printHelp();
  process.exit(0);
}

const transport = String(values['transport'] ?? 'stdio');
const host      = String(values['host']      ?? '0.0.0.0');
const port      = Number(values['port']      ?? '8000');
const proxyPort = Number(values['proxy-port']?? '0');

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 65_535;
}

if (!['stdio', 'streamable-http'].includes(transport)) {
  process.stderr.write(
    `Unknown transport "${transport}". Supported: stdio, streamable-http\n`
  );
  process.exit(1);
}

if (!isValidPort(port) || !isValidPort(proxyPort)) {
  process.stderr.write(
    `Invalid port. --port and --proxy-port must be integers from 0 to 65535. ` +
    `Use --proxy-port 0 to let the OS choose a random free proxy port.\n`
  );
  process.exit(1);
}

state.transport      = transport as 'stdio' | 'streamable-http';
state.proxyPortConfig = proxyPort;

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  if (state.proxyServer) {
    state.proxyServer.close();
    state.proxyServer = null;
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------------------------------------------------------------------------
// Start transport
// ---------------------------------------------------------------------------

async function main() {
  if (transport === 'stdio') {
    const server: McpServer = buildMcpServer();
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    return; // process kept alive by stdin
  }

  // ── streamable-http ────────────────────────────────────────────────────────
  //
  // Session map: Mcp-Session-Id → { transport, lastSeen }.
  // Each MCP client initialises once and reuses its session for all subsequent
  // requests.  A new (server, transport) pair per session satisfies the SDK's
  // 1:1 server↔transport constraint.
  // Sessions are evicted by transport.onclose OR after SESSION_TTL_MS of
  // inactivity to prevent unbounded growth in long-running servers.

  const SESSION_TTL_MS = 60 * 60 * 1_000; // 1 hour
  const sessions = new Map<string, {
    transport: StreamableHTTPServerTransport;
    lastSeen: number;
  }>();

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastSeen < cutoff) {
        entry.transport.close().catch(() => { /* ignore */ });
        sessions.delete(id);
      }
    }
  }, 5 * 60 * 1_000);
  cleanupTimer.unref();

  // --------------------------------------------------------------------------
  // Hono app
  // --------------------------------------------------------------------------

  const app = new Hono<{ Bindings: HttpBindings }>();

  // Middleware: capture the server-side IP from each incoming connection so
  // search_documentation can rewrite load_url values for remote browsers.
  app.use('*', async (c, next) => {
    const raw = c.env.incoming.socket.localAddress ?? '';
    const ip  = raw.replace(/^::ffff:/, '');
    if (ip && ip !== '0.0.0.0' && ip !== '::' && ip !== '::1') {
      state.serverIp = ip;
    }
    return next();
  });

  // MCP endpoint — all HTTP methods (GET for SSE streams, POST for messages,
  // DELETE for session teardown).
  app.all('/mcp', async (c) => {
    const req = c.env.incoming;
    const res = c.env.outgoing;

    // Parse JSON body for POST requests; other methods carry no body.
    let body: unknown;
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      try { body = await c.req.json(); } catch { /* empty / non-JSON body */ }
    }

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && sessions.has(sessionId)) {
      const entry = sessions.get(sessionId)!;
      entry.lastSeen = Date.now();
      await entry.transport.handleRequest(req, res, body);
    } else {
      // New session — typically an initialize request.
      // sessionId is assigned INSIDE handleRequest, so we store it AFTER.
      const mcpTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      mcpTransport.onclose = () => {
        if (mcpTransport.sessionId) sessions.delete(mcpTransport.sessionId);
      };
      const sessionServer = buildMcpServer();
      await sessionServer.connect(mcpTransport);
      await mcpTransport.handleRequest(req, res, body);
      if (mcpTransport.sessionId && !sessions.has(mcpTransport.sessionId)) {
        sessions.set(mcpTransport.sessionId, {
          transport: mcpTransport,
          lastSeen: Date.now(),
        });
      }
    }

    // transport.handleRequest writes directly to `res` (Node.js ServerResponse).
    // Return the sentinel header so @hono/node-server skips its own write step.
    return new Response(null, { headers: { 'x-hono-already-sent': '1' } });
  });

  // --------------------------------------------------------------------------
  // Start server
  // --------------------------------------------------------------------------

  serve(
    { fetch: app.fetch, hostname: host, port, overrideGlobalObjects: false },
    (info) => {
      process.stderr.write(
        `Dash MCP server (streamable-http) listening on http://${info.address}:${info.port}/mcp\n` +
        `Reverse proxy will start on ${proxyPort === 0 ? 'a random free port' : `port ${proxyPort}`} when setup_dash is called.\n`
      );
    }
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`);
  process.exit(1);
});
