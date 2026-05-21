/**
 * MCP server definition.
 * Registers all five tools using McpServer.registerTool() with proper annotations.
 */

import type { Server as HttpServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { state, requireDashUrl } from './state';
import {
  ensureDashApiReady,
  listDocsets,
  searchDocs,
  enableFts,
  fetchPage,
  DashApiError,
  detectContentServerPort,
} from './dashClient';
import { startProxy, makeDynamicPortResolver } from './proxy';
import { parseFragment, extractSection, htmlToText, estimateTokens } from './htmlUtils';

// ---------------------------------------------------------------------------
// Shared schema helpers
// ---------------------------------------------------------------------------

/**
 * A non-empty string schema that trims leading/trailing whitespace before
 * validation.  This prevents confusing errors when a user passes `" "` or `"\t"`
 * as a query or identifier.
 */
const trimmedNonEmpty = (description: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, `${description} cannot be empty or contain only whitespace`))
    .describe(description);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_LIMIT = 25_000;
const TOKEN_OVERHEAD = 100; // base overhead for response envelope

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps any JSON-serialisable value as an MCP text content result. */
function textResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Returns a human-readable string from any caught value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withSetupDashAgainHint(message: string): string {
  return `${message} If Dash was restarted or its local ports changed, call setup_dash again and retry.`;
}

function listeningPort(server: HttpServer): number {
  const address = server.address();
  if (typeof address === 'object' && address !== null) return address.port;
  throw new Error('Proxy server started but its listening port could not be determined.');
}

async function waitForListening(server: HttpServer): Promise<number> {
  if (server.listening) return listeningPort(server);

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = () => { cleanup(); resolve(); };
    const onError = (err: Error) => { cleanup(); reject(err); };

    server.once('listening', onListening);
    server.once('error', onError);
  });

  return listeningPort(server);
}

// ---------------------------------------------------------------------------
// buildMcpServer
// ---------------------------------------------------------------------------

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'Dash Documentation API', version: '1.0.0' });

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 1: setup_dash
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'setup_dash',
    {
      title: 'Setup Dash',
      description:
        'Initialize the Dash documentation browser and enable its API server. ' +
        'Must be called before using any other Dash tools. ' +
        'In HTTP transport mode, also starts a reverse proxy (default: random free port; ' +
        'use --proxy-port to pin a fixed port) that makes Dash documentation ' +
        'URLs accessible from other machines on the LAN.',
      annotations: { openWorldHint: true },
    },
    async () => {
      const result = await ensureDashApiReady();

      if ('error' in result) {
        return textResult({
          success: false,
          dashApiUrl: null,
          proxyUrl: null,
          message: result.error,
          error: result.error,
        });
      }

      // Cache the Dash API URL and port in state
      state.dashUrl = result.url;
      state.dashApiPort = result.port;

      // Detect the content server port from load_url values (separate from API port).
      // Errors propagate here: network failures or unexpected API responses are surfaced
      // explicitly rather than silently degrading to null.
      // Returns null only when no docsets are installed or the index has no entries.
      let contentPort: number | null;
      let contentPortWarning: string | undefined;
      try {
        contentPort = await detectContentServerPort(result.url);
      } catch (err) {
        // Detection failed for a real reason (API/network/parse error).
        // Keep Dash API ready but flag the proxy as non-functional.
        contentPort = null;
        contentPortWarning =
          `Content server port detection failed: ${errorMessage(err)}. ` +
          'The proxy will not work until setup_dash succeeds with docsets installed.';
      }
      state.contentServerPort = contentPort;

      // In HTTP mode: start the reverse proxy if not already running.
      // --proxy-port 0 is supported: Node chooses a random free port and we
      // store the actual assigned port after the server starts listening.
      let proxyUrl: string | null = null;
      if (state.transport !== 'stdio' && !state.proxyServer) {
        // The proxy forwards to the content server port.
        // If we couldn't detect it yet (no docsets), proxy returns 503 until setup_dash is called again.
        const proxyServer = startProxy(
          state.proxyPortConfig,
          // getTargetPort reads state.contentServerPort live; no wrong-port fallback.
          makeDynamicPortResolver(() => state.contentServerPort),
          // onStalePort: called on ECONNREFUSED — Dash has restarted and the
          // content server is now on a new port.  Null the cached value so the
          // proxy returns 503 and tells the client to call setup_dash again.
          () => { state.contentServerPort = null; }
        );

        try {
          state.proxyPort = await waitForListening(proxyServer);
          state.proxyServer = proxyServer;
        } catch (err) {
          proxyServer.close();
          state.proxyServer = null;
          state.proxyPort = null;
          return textResult({
            success: false,
            dashApiUrl: result.url,
            contentServerPort: contentPort,
            proxyUrl: null,
            message: `Dash API ready at ${result.url}, but the reverse proxy failed to start: ${errorMessage(err)}`,
            error: `Reverse proxy failed to start: ${errorMessage(err)}`,
          });
        }
      }
      if (state.transport !== 'stdio' && state.proxyPort !== null) {
        // Use the server IP captured from the incoming HTTP request (set by middleware)
        const ip = state.serverIp ?? '(unknown — connect via HTTP first)';
        proxyUrl = `http://${ip}:${state.proxyPort}`;
      }

      const message = proxyUrl
        ? `Dash API ready at ${result.url}. ` +
          `Content server on port ${contentPort ?? 'unknown'}. ` +
          `Reverse proxy available at ${proxyUrl} — ` +
          `documentation load_urls have been rewritten to use this proxy.`
        : `Dash API ready at ${result.url}.`;

      return textResult({
        success: true,
        dashApiUrl: result.url,
        contentServerPort: contentPort,
        proxyPort: state.transport !== 'stdio' ? state.proxyPort : null,
        proxyUrl,
        message,
        ...(contentPortWarning !== undefined && { warning: contentPortWarning }),
      });
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 2: list_installed_docsets
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'list_installed_docsets',
    {
      title: 'List Installed Docsets',
      description:
        'List all documentation sets installed in Dash. ' +
        'Returns an empty list when no docsets are installed. ' +
        'Results are automatically truncated if they would exceed 25,000 tokens.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      let baseUrl: string;
      try {
        baseUrl = requireDashUrl();
      } catch (err) {
        return textResult({ docsets: [], error: errorMessage(err) });
      }

      try {
        const data = await listDocsets(baseUrl);
        const allDocsets = (data['docsets'] as unknown[]) ?? [];

        // Apply token budget
        let tokens = TOKEN_OVERHEAD;
        const limited: unknown[] = [];
        for (const d of allDocsets) {
          const t = estimateTokens(d);
          if (tokens + t > TOKEN_LIMIT) break;
          limited.push(d);
          tokens += t;
        }

        const truncated = limited.length < allDocsets.length;
        return textResult({
          docsets: limited,
          truncated,
          ...(truncated && {
            truncatedCount: allDocsets.length - limited.length,
            truncationNotice:
              `Results truncated: showing ${limited.length} of ${allDocsets.length} docsets ` +
              `to stay within the 25,000 token limit.`,
          }),
        });
      } catch (err) {
        if (err instanceof DashApiError && err.status === 404) {
          return textResult({
            docsets: [],
            error:
              'No docsets found. ' +
              'Please install docsets in Dash → Settings → Downloads.',
          });
        }
        return textResult({
          docsets: [],
          error: withSetupDashAgainHint(`Failed to list docsets: ${errorMessage(err)}.`),
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 3: search_documentation
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'search_documentation',
    {
      title: 'Search Documentation',
      description:
        'Search for documentation entries across docsets and code snippets. ' +
        'Call list_installed_docsets first to obtain valid docset identifiers. ' +
        'Results are automatically truncated at 25,000 tokens.',
      inputSchema: z.object({
        query: trimmedNonEmpty('The search query string'),
        docsetIdentifiers: z
          .array(z.string())
          .describe(
            'List of docset identifiers to search in (from list_installed_docsets). ' +
              'Must not be empty.'
          ),
        searchSnippets: z
          .boolean()
          .default(true)
          .describe('Whether to include code snippets in search results'),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .default(100)
          .describe('Maximum number of results to return (1–1000)'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, docsetIdentifiers, searchSnippets, maxResults }) => {
      let baseUrl: string;
      try {
        baseUrl = requireDashUrl();
      } catch (err) {
        return textResult({ results: [], error: errorMessage(err) });
      }

      if (docsetIdentifiers.length === 0) {
        return textResult({
          results: [],
          error:
            'docsetIdentifiers must not be empty. ' +
            'Use list_installed_docsets to obtain valid identifiers.',
        });
      }

      try {
        const data = await searchDocs(baseUrl, {
          query,
          docsetIdentifiers: docsetIdentifiers.join(','),
          searchSnippets,
          maxResults,
        });

        // Dash may return a non-error advisory message — keep it separate from error
        const warning = (data['message'] as string | undefined) ?? undefined;

        // Filter out empty-object entries Dash returns when there are no results
        let results = ((data['results'] as unknown[]) ?? []).filter(
          (r) => r !== null && typeof r === 'object' && Object.keys(r as object).length > 0
        ) as Record<string, unknown>[];

        if (results.length === 0 && query.includes(' ')) {
          return textResult({
            results: [],
            warning,
            error: 'Nothing found. Try searching for fewer terms.',
          });
        }

        // Rewrite load_url values so remote clients can open them directly in a browser.
        // Only applies in HTTP mode when the proxy is running and we know our server IP.
        const shouldRewrite =
          state.transport !== 'stdio' &&
          state.proxyPort !== null &&
          state.serverIp !== null &&
          state.contentServerPort !== null;

        if (shouldRewrite) {
          const from = `http://127.0.0.1:${state.contentServerPort}`;
          const to = `http://${state.serverIp}:${state.proxyPort}`;
          results = results.map((r) => ({
            ...r,
            load_url: typeof r['load_url'] === 'string' ? r['load_url'].replace(from, to) : r['load_url'],
          }));
        }

        // Apply token budget
        let tokens = TOKEN_OVERHEAD;
        const limited: Record<string, unknown>[] = [];
        for (const r of results) {
          const t = estimateTokens(r);
          if (tokens + t > TOKEN_LIMIT) break;
          limited.push(r);
          tokens += t;
        }

        const truncated = limited.length < results.length;
        return textResult({
          results: limited,
          truncated,
          ...(truncated && {
            truncatedCount: results.length - limited.length,
            truncationNotice:
              `Results truncated: showing ${limited.length} of ${results.length} results ` +
              `to stay within the 25,000 token limit. ` +
              `Refine your query or reduce maxResults.`,
          }),
          ...(warning !== undefined && { warning }),
        });
      } catch (err) {
        if (err instanceof DashApiError) {
          if (err.status === 400) {
            const msg = err.body.toLowerCase();
            if (msg.includes('not found') || msg.includes('identifier')) {
              return textResult({
                results: [],
                error:
                  'Invalid docset identifier. ' +
                  'Run list_installed_docsets to see available docsets and use the exact identifier. ' +
                  `Details: ${err.body}`,
              });
            }
            return textResult({ results: [], error: `Bad request: ${err.body}` });
          }
          if (err.status === 403) {
            if (err.body.includes('trial')) {
              return textResult({
                results: [],
                error: 'Dash trial has expired. Purchase Dash at https://kapeli.com/dash.',
              });
            }
            return textResult({ results: [], error: `Forbidden: ${err.body}` });
          }
        }
        return textResult({
          results: [],
          error: withSetupDashAgainHint(`Search failed: ${errorMessage(err)}.`),
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 4: load_documentation_page
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'load_documentation_page',
    {
      title: 'Load Documentation Page',
      description:
        'Fetch and convert a documentation page to Markdown. ' +
        'The loadUrl must come from a search_documentation result. ' +
        'In HTTP transport mode, proxy-rewritten URLs are also accepted.',
      inputSchema: z.object({
        loadUrl: z.string().describe('The load_url value from a search_documentation result'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ loadUrl }) => {
      // ── 1. Parse and validate scheme ────────────────────────────────────────
      let parsed: URL;
      try {
        parsed = new URL(loadUrl);
      } catch {
        return textResult({ content: '', loadUrl, error: 'Invalid URL format.' });
      }

      if (parsed.protocol !== 'http:') {
        return textResult({
          content: '', loadUrl,
          error: 'Invalid URL: only http:// scheme is accepted.',
        });
      }

      // ── 2. Require setup_dash to have been called ────────────────────────────
      // This ensures we know the exact Dash port(s) and prevents SSRF before
      // any port information is available.
      try {
        requireDashUrl();
      } catch (err) {
        return textResult({ content: '', loadUrl, error: errorMessage(err) });
      }

      // ── 3. Strict (hostname, port) allow-list ───────────────────────────────
      // Only two pairs are ever valid:
      //   • 127.0.0.1:<contentServerPort>  — direct Dash content server
      //   • <serverIp>:<proxyPort>          — proxy-rewritten URL (HTTP mode)
      //
      // Any other port on 127.0.0.1 (Redis, Postgres, SSH …) is rejected,
      // preventing SSRF against other local services.
      if (state.contentServerPort === null && state.proxyPort === null) {
        return textResult({
          content: '', loadUrl,
          error:
            'Dash content server port is unknown. ' +
            'Please call setup_dash again to re-detect it.',
        });
      }

      const urlPort = parsed.port || '80';
      const isAllowedDirect =
        parsed.hostname === '127.0.0.1' &&
        state.contentServerPort !== null &&
        urlPort === String(state.contentServerPort);
      const isAllowedProxy =
        state.serverIp !== null &&
        parsed.hostname === state.serverIp &&
        state.proxyPort !== null &&
        urlPort === String(state.proxyPort);

      if (!isAllowedDirect && !isAllowedProxy) {
        return textResult({
          content: '', loadUrl,
          error:
            `Invalid URL: ${parsed.hostname}:${urlPort} is not a known Dash port. ` +
            'Only URLs returned by search_documentation are accepted.',
        });
      }

      // ── 4. Reverse-rewrite proxy URL to internal Dash URL for fetching ───────
      let fetchUrl = loadUrl;
      if (isAllowedProxy && state.contentServerPort !== null) {
        fetchUrl = loadUrl.replace(
          `http://${state.serverIp}:${state.proxyPort}`,
          `http://127.0.0.1:${state.contentServerPort}`
        );
      }

      try {
        const html = await fetchPage(fetchUrl);
        // Use the original loadUrl's fragment for section extraction
        const anchorId = parseFragment(loadUrl);
        const section = extractSection(html, anchorId);
        const content = htmlToText(section);
        return textResult({ content, loadUrl });
      } catch (err) {
        if (err instanceof DashApiError) {
          if (err.status === 403 && err.body.includes('trial')) {
            return textResult({
              content: '',
              loadUrl,
              error: 'Dash trial has expired. Purchase Dash at https://kapeli.com/dash.',
            });
          }
          if (err.status === 404) {
            return textResult({
              content: '',
              loadUrl,
              error: 'Documentation page not found.',
            });
          }
          return textResult({ content: '', loadUrl, error: `HTTP error: ${err.message}` });
        }
        return textResult({
          content: '',
          loadUrl,
          error: withSetupDashAgainHint(`Failed to load page: ${errorMessage(err)}.`),
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Tool 5: enable_docset_fts
  // ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'enable_docset_fts',
    {
      title: 'Enable Full-Text Search',
      description:
        'Enable full-text search (FTS) indexing for a specific docset. ' +
        'This improves search quality but requires time to index. ' +
        'Calling this multiple times for the same docset is safe (idempotent). ' +
        'Use list_installed_docsets to obtain valid identifiers.',
      inputSchema: z.object({
        identifier: trimmedNonEmpty('The docset identifier (from list_installed_docsets)'),
      }),
      annotations: { idempotentHint: true },
    },
    async ({ identifier }) => {
      let baseUrl: string;
      try {
        baseUrl = requireDashUrl();
      } catch (err) {
        return textResult({ success: false, identifier, error: errorMessage(err) });
      }

      try {
        await enableFts(baseUrl, identifier);
        return textResult({ success: true, identifier });
      } catch (err) {
        if (err instanceof DashApiError) {
          if (err.status === 404) {
            return textResult({
              success: false,
              identifier,
              error:
                `Docset '${identifier}' not found. ` +
                'Run list_installed_docsets to see available docsets and use the exact identifier.',
            });
          }
          if (err.status === 400) {
            return textResult({
              success: false,
              identifier,
              error: `Bad request: ${err.body}. Verify the identifier is correct.`,
            });
          }
          return textResult({
            success: false,
            identifier,
            error: `HTTP error ${err.status}: ${err.body}`,
          });
        }
        return textResult({
          success: false,
          identifier,
          error: withSetupDashAgainHint(`Failed to enable FTS: ${errorMessage(err)}.`),
        });
      }
    }
  );

  return server;
}
