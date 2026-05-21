/**
 * Async Dash API client.
 * All I/O is non-blocking: fetch() for HTTP, child_process for subprocesses,
 * fs.promises for file reads.
 */

import { execFile as execFileCb } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/** Path to Dash's API server status file (written by Dash when the API server starts). */
const STATUS_JSON_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Dash',
  '.dash_api_server',
  'status.json'
);

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

export class DashApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string
  ) {
    super(`HTTP ${status}: ${body}`);
    this.name = 'DashApiError';
  }
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Returns true if any Dash process (regular or Setapp) is running. */
export async function isDashRunning(): Promise<boolean> {
  try {
    await execFile('pgrep', ['-f', 'Dash']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Launches Dash in the background (hidden, without activating).
 * Tries the direct App Store bundle first, then the Setapp bundle.
 */
export async function launchDash(): Promise<void> {
  try {
    await execFile('open', ['-g', '-j', '-b', 'com.kapeli.dashdoc']);
  } catch {
    try {
      await execFile('open', ['-g', '-j', '-b', 'com.kapeli.dash-setapp']);
    } catch {
      throw new Error(
        'Failed to launch Dash. Please open Dash manually and try again.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// API server discovery
// ---------------------------------------------------------------------------

/**
 * Reads the Dash API server port from its status.json file.
 * Returns null if the file is absent or unparseable (API server not running).
 */
export async function getDashApiPort(): Promise<number | null> {
  try {
    const data = await fs.promises.readFile(STATUS_JSON_PATH, 'utf-8');
    const json = JSON.parse(data) as { port?: number };
    return json.port ?? null;
  } catch {
    return null;
  }
}

/**
 * Writes the DHAPIServerEnabled defaults key for both App Store and Setapp
 * Dash variants. Errors are swallowed because one variant likely won't exist.
 */
export async function enableDashApiServer(): Promise<void> {
  const write = (bundle: string) =>
    execFile('defaults', ['write', bundle, 'DHAPIServerEnabled', 'YES']).catch(() => {
      /* ignore – the other variant may not be installed */
    });
  await Promise.all([
    write('com.kapeli.dashdoc'),
    write('com.kapeli.dash-setapp'),
  ]);
}

/** Returns true if the Dash API server at the given port responds to /health. */
export async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// High-level setup
// ---------------------------------------------------------------------------

export type SetupSuccess = { port: number; url: string };
export type SetupFailure = { error: string };

/**
 * Ensures Dash is running and its API server is reachable.
 * Launches Dash if needed, enables the API server if needed, then health-checks.
 * Returns either a success object with port+url, or an error object.
 */
export async function ensureDashApiReady(): Promise<SetupSuccess | SetupFailure> {
  // Step 1 – ensure Dash is running
  if (!(await isDashRunning())) {
    try {
      await launchDash();
      await delay(4_000); // Give Dash time to initialise
    } catch (err) {
      return { error: (err as Error).message };
    }
    if (!(await isDashRunning())) {
      return { error: 'Dash did not start. Please launch Dash manually and try again.' };
    }
  }

  // Step 2 – get the API port (enable the API server if not already)
  let port = await getDashApiPort();
  if (port === null) {
    await enableDashApiServer();
    await delay(2_000);
    port = await getDashApiPort();
    if (port === null) {
      return {
        error:
          'Dash API Server is not enabled. ' +
          'Please enable it manually in Dash → Settings → Integration, then call setup_dash again.',
      };
    }
  }

  // Step 3 – health check
  if (!(await checkHealth(port))) {
    return {
      error:
        `Dash API server on port ${port} is not responding. ` +
        'Please check Dash → Settings → Integration and verify the API server is enabled.',
    };
  }

  return { port, url: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------
// Dash API calls
// ---------------------------------------------------------------------------

type JsonObj = Record<string, unknown>;

/** Lists all installed docsets. Throws DashApiError on HTTP failure. */
export async function listDocsets(baseUrl: string): Promise<JsonObj> {
  const res = await fetch(`${baseUrl}/docsets/list`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new DashApiError(res.status, await res.text());
  return res.json() as Promise<JsonObj>;
}

export interface SearchParams {
  query: string;
  /** Comma-separated docset identifiers (Dash API format). */
  docsetIdentifiers: string;
  searchSnippets: boolean;
  maxResults: number;
}

/** Searches documentation. Throws DashApiError on HTTP failure. */
export async function searchDocs(baseUrl: string, params: SearchParams): Promise<JsonObj> {
  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set('query', params.query);
  url.searchParams.set('docset_identifiers', params.docsetIdentifiers);
  url.searchParams.set('search_snippets', String(params.searchSnippets));
  url.searchParams.set('max_results', String(params.maxResults));
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new DashApiError(res.status, await res.text());
  return res.json() as Promise<JsonObj>;
}

/** Enables full-text search for a docset. Throws DashApiError on HTTP failure. */
export async function enableFts(baseUrl: string, identifier: string): Promise<void> {
  const url = new URL(`${baseUrl}/docsets/enable_fts`);
  url.searchParams.set('identifier', identifier);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new DashApiError(res.status, await res.text());
}

/** Fetches the raw HTML of a documentation page. Throws DashApiError on HTTP failure. */
export async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new DashApiError(res.status, await res.text());
  return res.text();
}

/**
 * Detects the port used by Dash's content (documentation file) server by
 * listing docsets, running a minimal search, and parsing the port from the
 * first load_url in the results.
 *
 * Returns null only when there are legitimately no docsets installed or no
 * search results (e.g. empty docset index).  All other failures — network
 * errors, unexpected API responses, malformed URLs — are thrown so the caller
 * can surface them explicitly rather than silently degrading.
 */
export async function detectContentServerPort(apiBaseUrl: string): Promise<number | null> {
  // Throws DashApiError on network / API failure — do NOT catch here.
  const docsetData = await listDocsets(apiBaseUrl);
  const docsets = (docsetData['docsets'] as { identifier: string }[]) ?? [];
  if (docsets.length === 0) return null; // legitimate: no docsets installed

  const searchData = await searchDocs(apiBaseUrl, {
    query: 'a',
    docsetIdentifiers: docsets[0].identifier,
    searchSnippets: false,
    maxResults: 1,
  });
  const results = (searchData['results'] as { load_url?: string }[]) ?? [];
  const firstUrl = results.find((r) => r.load_url)?.load_url;
  if (!firstUrl) return null; // legitimate: docset has no indexed entries yet

  // Let URL and parseInt errors propagate — they indicate an unexpected Dash
  // API response format that should be visible, not swallowed.
  const parsed = new URL(firstUrl);
  const port = parseInt(parsed.port, 10);
  if (isNaN(port)) {
    throw new Error(`Unexpected load_url format — no port found in: ${firstUrl}`);
  }
  return port;
}
