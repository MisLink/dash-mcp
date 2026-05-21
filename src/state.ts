/**
 * Application state singleton.
 * Holds the Dash API URL (set after setup_dash), proxy server handle,
 * the server IP captured from HTTP client connections, and runtime config.
 */

import type { Server as HttpServer } from 'node:http';

interface AppState {
  /** Verified Dash API base URL, e.g. http://127.0.0.1:12345. Null until setup_dash succeeds. */
  dashUrl: string | null;
  /** Numeric port for the Dash API server (extracted from dashUrl). Used for URL rewriting. */
  dashApiPort: number | null;
  /**
   * Port of Dash's content (documentation file) server, detected from load_url values.
   * Different from dashApiPort — this is what load_urls actually point to.
   */
  contentServerPort: number | null;
  /** Running HTTP reverse proxy server, or null if not started yet. */
  proxyServer: HttpServer | null;
  /** Port the proxy is listening on, or null if not started. */
  proxyPort: number | null;
  /**
   * The server-side IP captured from incoming HTTP requests (req.socket.localAddress).
   * This is the address clients actually connected to, so it's safe to use in rewritten URLs.
   * Null in stdio mode or before the first HTTP request arrives.
   */
  serverIp: string | null;
  /** MCP transport mode, set at startup. */
  transport: 'stdio' | 'sse' | 'streamable-http';
  /** The proxy port specified via --proxy-port CLI flag (default 0 = random free port). */
  proxyPortConfig: number;
}

export const state: AppState = {
  dashUrl: null,
  dashApiPort: null,
  contentServerPort: null,
  proxyServer: null,
  proxyPort: null,
  serverIp: null,
  transport: 'stdio',
  proxyPortConfig: 0,
};

/**
 * Returns the Dash API base URL if setup_dash has been called, or throws a
 * descriptive Error if not yet initialized.
 */
export function requireDashUrl(): string {
  if (!state.dashUrl) {
    throw new Error(
      'Dash API is not ready. Please call the setup_dash tool first to ' +
        'launch Dash and enable its API server.'
    );
  }
  return state.dashUrl;
}
