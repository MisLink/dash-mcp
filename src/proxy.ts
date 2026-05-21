/**
 * HTTP reverse proxy for Dash documentation content server.
 * Listens on 0.0.0.0:PROXY_PORT and forwards requests to the local Dash content
 * server (127.0.0.1:CONTENT_PORT). The content port is resolved dynamically on
 * every request from application state.
 *
 * Uses the `http-proxy` npm package (not a hand-rolled proxy).
 */

import * as http from 'node:http';
import httpProxy from 'http-proxy';

// ---------------------------------------------------------------------------
// Content-port resolver
// ---------------------------------------------------------------------------

/**
 * Reads the content server port from state if available.
 *
 * The getDashApiPort() fallback has been intentionally removed: the API port
 * and the documentation content port are different services.  Returning the
 * API port as a content-server target would silently proxy to the wrong
 * endpoint.  When the state port is null (e.g. after Dash restarts and
 * ECONNREFUSED invalidates it) the proxy returns 503 and the client sees a
 * clear error rather than garbage content from the wrong service.
 */
export function makeDynamicPortResolver(
  getStatePort: () => number | null
): () => Promise<number | null> {
  return async () => getStatePort();
}

/**
 * Starts a reverse proxy server that forwards all requests to the local Dash
 * documentation content server.
 *
 * The target port is resolved dynamically via `getTargetPort()` on every
 * request, so the proxy tolerates Dash restarts as long as the state is
 * refreshed (by calling setup_dash again).
 *
 * @param proxyPort     - Port to listen on (bound on 0.0.0.0 for LAN access).
 * @param getTargetPort - Async fn that returns the current content server port,
 *                        or null if Dash is not ready.
 * @param onStalePort   - Called when a connection is refused (ECONNREFUSED),
 *                        indicating Dash has restarted and the cached port is
 *                        stale.  Typically sets state.contentServerPort = null
 *                        so subsequent requests return 503 instead of routing
 *                        to the wrong port.
 * @returns The Node http.Server so the caller can close it on shutdown.
 */
export function startProxy(
  proxyPort: number,
  getTargetPort: () => Promise<number | null>,
  onStalePort?: () => void
): http.Server {
  const proxy = httpProxy.createProxyServer({});

  proxy.on('error', (err, _req, res) => {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ECONNREFUSED') {
      // Target port is stale (Dash has restarted).  Invalidate the cached port
      // so the next request returns 503 with a clear error instead of routing
      // to an unrelated service that may have grabbed the same port number.
      onStalePort?.();
    }
    const r = res as http.ServerResponse;
    if (!r.headersSent) {
      r.writeHead(nodeErr.code === 'ECONNREFUSED' ? 503 : 502, { 'Content-Type': 'text/plain' });
    }
    const retryHint = nodeErr.code === 'ECONNREFUSED'
      ? ' Dash content server port appears stale. Please call setup_dash again and retry.'
      : '';
    r.end(`Proxy error: ${(err as Error).message}.${retryHint}`);
  });

  const server = http.createServer(async (req, res) => {
    // Built-in health check — returns proxy status and detected content server port
    if (req.method === 'GET' && req.url === '/health') {
      const port = await getTargetPort();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', contentServerPort: port }));
      return;
    }

    const port = await getTargetPort();
    if (port === null) {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('Dash documentation server is not available. Please call the setup_dash tool again and retry.');
      return;
    }
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  });

  server.listen(proxyPort, '0.0.0.0', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : proxyPort;
    process.stderr.write(
      `Dash proxy listening on 0.0.0.0:${actualPort} → Dash content server (dynamic port)\n`
    );
  });

  return server;
}
