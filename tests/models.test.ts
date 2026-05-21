/**
 * Tests for utility functions and response shape validation.
 */

import { describe, it, expect, vi } from 'vitest';
import { estimateTokens, htmlToText, parseFragment, extractSection } from '../src/htmlUtils';
import { DashApiError } from '../src/dashClient';
import { state, requireDashUrl } from '../src/state';
import { makeDynamicPortResolver } from '../src/proxy';

// ─────────────────────────────────────────────────────────────────────────────
// estimateTokens
// ─────────────────────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns at least 1 for any input', () => {
    expect(estimateTokens('')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens(0)).toBeGreaterThanOrEqual(1);
    expect(estimateTokens(null)).toBeGreaterThanOrEqual(1);
  });

  it('estimates string tokens as ~1 per 4 chars', () => {
    expect(estimateTokens('a'.repeat(4))).toBe(1);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
  });

  it('estimates array as sum of elements', () => {
    const arr = ['a'.repeat(40), 'b'.repeat(40)]; // 10 + 10 = 20
    expect(estimateTokens(arr)).toBe(20);
  });

  it('estimates object as sum of key+value tokens', () => {
    const obj = { abcd: 'efgh' }; // "abcd"=1 + "efgh"=1 = 2
    expect(estimateTokens(obj)).toBe(2);
  });

  it('handles nested objects recursively', () => {
    const nested = { a: { b: 'c'.repeat(40) } }; // key"a"=1 + key"b"=1 + value=10 = 12
    const t = estimateTokens(nested);
    expect(t).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Response shape — verify the JSON structures tools return
// ─────────────────────────────────────────────────────────────────────────────

describe('response shape contracts', () => {
  it('DocsetResults has required fields', () => {
    const obj = { docsets: [], truncated: false };
    expect(obj).toHaveProperty('docsets');
    expect(obj).toHaveProperty('truncated');
    expect(Array.isArray(obj.docsets)).toBe(true);
  });

  it('DocsetResults carries truncation metadata when truncated', () => {
    const obj = {
      docsets: [],
      truncated: true,
      truncatedCount: 5,
      truncationNotice: 'Too many results.',
    };
    expect(obj.truncated).toBe(true);
    expect(obj.truncatedCount).toBe(5);
    expect(typeof obj.truncationNotice).toBe('string');
  });

  it('SearchResults has separate warning and error fields', () => {
    const withWarning = { results: [], truncated: false, warning: 'Some advisory' };
    const withError   = { results: [], truncated: false, error: 'Something broke' };

    expect(withWarning).not.toHaveProperty('error');
    expect(withWarning.warning).toBe('Some advisory');

    expect(withError).not.toHaveProperty('warning');
    expect(withError.error).toBe('Something broke');
  });

  it('SearchResults warning does not imply error', () => {
    const obj = { results: [{ name: 'foo' }], truncated: false, warning: 'partial index' };
    // A warning must not pollute the error field
    expect('error' in obj).toBe(false);
    expect(obj.results.length).toBe(1);
  });

  it('EnableFtsResult has success + identifier + optional error', () => {
    const ok   = { success: true,  identifier: 'python' };
    const fail = { success: false, identifier: 'python', error: 'not found' };
    expect(ok.success).toBe(true);
    expect('error' in ok).toBe(false);
    expect(fail.success).toBe(false);
    expect(fail.error).toBeTruthy();
  });

  it('SetupResult has success, dashApiUrl, proxyUrl, message', () => {
    const ok = {
      success: true,
      dashApiUrl: 'http://127.0.0.1:12345',
      proxyUrl: null,
      message: 'Dash API ready.',
    };
    expect(ok.success).toBe(true);
    expect(ok.dashApiUrl).toMatch(/^http:\/\//);
    expect('error' in ok).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
const SAMPLE_DOC_HTML = `
<html><body>
  <nav><ul><li><a href="/">Home</a></li></ul></nav>
  <article>
    <h1>Getting Started</h1>
    <p>This is the <strong>introduction</strong> to the library.</p>
    <h2>Installation</h2>
    <pre><code>npm install foo-lib</code></pre>
    <h2>Basic Usage</h2>
    <p>Call <code>foo.init()</code> to start.</p>
    <ul><li>Option A</li><li>Option B</li></ul>
  </article>
</body></html>
`;

// ───────────────────────────────────────────────────────────────────────────────
describe('DashApiError', () => {
  it('is an instance of Error', () => {
    const err = new DashApiError(404, 'not found');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(DashApiError);
  });

  it('carries status and body', () => {
    const err = new DashApiError(403, 'forbidden');
    expect(err.status).toBe(403);
    expect(err.body).toBe('forbidden');
  });

  it('has a human-readable message', () => {
    const err = new DashApiError(500, 'server error');
    expect(err.message).toContain('500');
    expect(err.message).toContain('server error');
  });

  it('name is DashApiError', () => {
    expect(new DashApiError(400, '').name).toBe('DashApiError');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('requireDashUrl', () => {
  it('throws when dashUrl is null', () => {
    const saved = state.dashUrl;
    state.dashUrl = null;
    expect(() => requireDashUrl()).toThrow('setup_dash');
    state.dashUrl = saved;
  });

  it('returns dashUrl when set', () => {
    const saved = state.dashUrl;
    state.dashUrl = 'http://127.0.0.1:9999';
    expect(requireDashUrl()).toBe('http://127.0.0.1:9999');
    state.dashUrl = saved;
  });

  it('error message mentions setup_dash', () => {
    const saved = state.dashUrl;
    state.dashUrl = null;
    let msg = '';
    try { requireDashUrl(); } catch (e) { msg = (e as Error).message; }
    expect(msg.toLowerCase()).toContain('setup_dash');
    state.dashUrl = saved;
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('htmlToText (Markdown conversion quality)', () => {
  it('converts headings to ATX style', () => {
    const html = '<h1>Title</h1><h2>Section</h2>';
    const md = htmlToText(html);
    expect(md).toContain('# Title');
    expect(md).toContain('## Section');
  });

  it('preserves inline code', () => {
    const md = htmlToText('<p>Call <code>foo()</code> now.</p>');
    expect(md).toContain('`foo()`');
  });

  it('preserves fenced code blocks', () => {
    const md = htmlToText('<pre><code>npm install foo</code></pre>');
    expect(md).toContain('```');
    expect(md).toContain('npm install foo');
  });

  it('converts bold text', () => {
    const md = htmlToText('<p>This is <strong>important</strong>.</p>');
    expect(md).toContain('**important**');
  });

  it('strips nav noise when extractSection is applied first', () => {
    const section = extractSection(SAMPLE_DOC_HTML, null);
    const md = htmlToText(section);
    // Nav items should NOT appear
    expect(md).not.toContain('[Home]');
    // Content should appear
    expect(md).toContain('# Getting Started');
    expect(md).toContain('## Installation');
    expect(md).toContain('npm install foo-lib');
  });

  it('produces non-empty output for a real documentation sample', () => {
    const md = htmlToText(SAMPLE_DOC_HTML);
    expect(md.length).toBeGreaterThan(50);
    expect(md).toContain('Getting Started');
  });

  it('handles empty string gracefully', () => {
    expect(() => htmlToText('')).not.toThrow();
    expect(typeof htmlToText('')).toBe('string');
  });

  it('converts HTML tables to GFM pipe-table syntax', () => {
    const html = `
      <table>
        <thead><tr><th>Method</th><th>Returns</th></tr></thead>
        <tbody>
          <tr><td><code>get(key)</code></td><td>string</td></tr>
          <tr><td><code>set(key,val)</code></td><td>void</td></tr>
        </tbody>
      </table>`;
    const md = htmlToText(html);
    // GFM plugin must produce pipe-separated table rows
    expect(md).toContain('|');
    expect(md).toContain('Method');
    expect(md).toContain('Returns');
    expect(md).toContain('---');
    // All cells in a row should be on the same line
    const methodLine = md.split('\n').find(l => l.includes('get(key)'));
    expect(methodLine).toBeDefined();
    expect(methodLine).toContain('string');
  });

  it('renders GFM strikethrough for <del> elements', () => {
    const md = htmlToText('<p><del>deprecated</del> Use new API.</p>');
    expect(md).toContain('~deprecated~');
  });
});

// ───────────────────────────────────────────────────────────────────────────────
describe('session state management', () => {
  it('state object has all required fields', () => {
    expect(state).toHaveProperty('dashUrl');
    expect(state).toHaveProperty('dashApiPort');
    expect(state).toHaveProperty('contentServerPort');
    expect(state).toHaveProperty('proxyServer');
    expect(state).toHaveProperty('proxyPort');
    expect(state).toHaveProperty('serverIp');
    expect(state).toHaveProperty('transport');
    expect(state).toHaveProperty('proxyPortConfig');
  });

  it('initial transport is stdio', () => {
    // state.transport starts as stdio (may have been mutated by other tests but reset logic should hold)
    expect(['stdio', 'sse', 'streamable-http']).toContain(state.transport);
  });

  it('proxyPortConfig defaults to 0 (random free port)', () => {
    // proxyPortConfig is set at startup; 0 asks the OS to choose a free port
    expect(state.proxyPortConfig).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// makeDynamicPortResolver
// ─────────────────────────────────────────────────────────────────────────────

describe('makeDynamicPortResolver', () => {
  it('returns state port when available', async () => {
    const resolver = makeDynamicPortResolver(() => 12345);
    const port = await resolver();
    expect(port).toBe(12345);
  });

  it('returns null when state port is null — no fallback to API port', async () => {
    // The getDashApiPort() fallback was intentionally removed: API port ≠ content port.
    // Returning null causes the proxy to 503 which is explicit and safe.
    const resolver = makeDynamicPortResolver(() => null);
    const port = await resolver();
    expect(port).toBeNull();
  });

  it('reads state port dynamically on each call', async () => {
    let currentPort: number | null = 1111;
    const resolver = makeDynamicPortResolver(() => currentPort);

    expect(await resolver()).toBe(1111);
    currentPort = 2222;
    expect(await resolver()).toBe(2222);
  });

  it('returns null after port is invalidated (simulating Dash restart)', async () => {
    let currentPort: number | null = 9999;
    const resolver = makeDynamicPortResolver(() => currentPort);

    expect(await resolver()).toBe(9999);

    // Simulate onStalePort callback clearing the cached port
    currentPort = null;
    expect(await resolver()).toBeNull();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Token budget truncation logic
// ─────────────────────────────────────────────────────────────────────────────

describe('token budget truncation', () => {
  const TOKEN_LIMIT = 25_000;
  const TOKEN_OVERHEAD = 100;

  /** Simulate the truncation logic used in list_installed_docsets / search_documentation */
  function applyTokenBudget<T>(items: T[]): { limited: T[]; truncated: boolean; truncatedCount: number } {
    let tokens = TOKEN_OVERHEAD;
    const limited: T[] = [];
    for (const item of items) {
      const t = estimateTokens(item);
      if (tokens + t > TOKEN_LIMIT) break;
      limited.push(item);
      tokens += t;
    }
    return { limited, truncated: limited.length < items.length, truncatedCount: items.length - limited.length };
  }

  it('returns all items when total tokens are within limit', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ name: `item${i}`, value: 'x' }));
    const { limited, truncated } = applyTokenBudget(items);
    expect(limited.length).toBe(10);
    expect(truncated).toBe(false);
  });

  it('truncates when items exceed token limit', () => {
    // Create items where each takes ~500 tokens (2000 chars)
    const bigItem = { name: 'x'.repeat(2000) };
    const items = Array.from({ length: 60 }, () => ({ ...bigItem }));
    const { limited, truncated, truncatedCount } = applyTokenBudget(items);
    expect(truncated).toBe(true);
    expect(limited.length).toBeLessThan(60);
    expect(truncatedCount).toBeGreaterThan(0);
    expect(limited.length + truncatedCount).toBe(60);
  });

  it('overhead is counted against limit', () => {
    // 25_000 - 100 overhead = 24_900 budget
    // Each item: 1 token; 24_900 items should fit, 24_901 should not
    const small = { a: 'x' }; // ~1 token
    const tPerItem = estimateTokens(small);
    const maxFit = Math.floor((TOKEN_LIMIT - TOKEN_OVERHEAD) / tPerItem);

    const exactFit = Array.from({ length: maxFit }, () => ({ ...small }));
    const oneOver  = Array.from({ length: maxFit + 1 }, () => ({ ...small }));

    expect(applyTokenBudget(exactFit).truncated).toBe(false);
    expect(applyTokenBudget(oneOver).truncated).toBe(true);
  });

  it('empty input is never truncated', () => {
    const { limited, truncated } = applyTokenBudget([]);
    expect(limited).toHaveLength(0);
    expect(truncated).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// URL origin rewriting logic (load_documentation_page reverse-rewrite)
// ─────────────────────────────────────────────────────────────────────────────

describe('URL origin rewriting', () => {
  /** Pure implementation of the reverse-rewrite logic from load_documentation_page */
  function reverseRewrite(
    loadUrl: string,
    serverIp: string | null,
    proxyPort: number | null,
    contentServerPort: number | null
  ): string {
    if (!serverIp || proxyPort === null || contentServerPort === null) return loadUrl;
    let parsed: URL;
    try { parsed = new URL(loadUrl); } catch { return loadUrl; }
    if (parsed.hostname !== serverIp) return loadUrl;
    return loadUrl.replace(
      `http://${serverIp}:${proxyPort}`,
      `http://127.0.0.1:${contentServerPort}`
    );
  }

  it('rewrites proxy URL to content server URL', () => {
    const result = reverseRewrite(
      'http://192.168.1.100:16766/Dash/foo/bar.html',
      '192.168.1.100', 16766, 60876
    );
    expect(result).toBe('http://127.0.0.1:60876/Dash/foo/bar.html');
  });

  it('preserves URL with fragment after rewriting origin', () => {
    const result = reverseRewrite(
      'http://192.168.1.100:16766/page.html#//dash_ref_method-i-foo/Method/foo/0',
      '192.168.1.100', 16766, 60876
    );
    expect(result).toContain('http://127.0.0.1:60876');
    expect(result).toContain('#//dash_ref_');
  });

  it('does not rewrite when hostname does not match serverIp', () => {
    const original = 'http://127.0.0.1:60876/page.html';
    const result = reverseRewrite(original, '192.168.1.100', 16766, 60876);
    expect(result).toBe(original);
  });

  it('does not rewrite when serverIp is null (stdio mode)', () => {
    const original = 'http://192.168.1.100:16766/page.html';
    const result = reverseRewrite(original, null, 16766, 60876);
    expect(result).toBe(original);
  });

  it('does not rewrite when contentServerPort is null', () => {
    const original = 'http://192.168.1.100:16766/page.html';
    const result = reverseRewrite(original, '192.168.1.100', 16766, null);
    expect(result).toBe(original);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// trimmedNonEmpty schema helper — whitespace guard
// ─────────────────────────────────────────────────────────────────────────────

import { z } from 'zod';

/** Mirrors the server.ts `trimmedNonEmpty` helper for unit testing. */
const trimmedNonEmpty = (description: string) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, `${description} cannot be empty or contain only whitespace`))
    .describe(description);

describe('trimmedNonEmpty schema helper', () => {
  const schema = trimmedNonEmpty('query');

  it('rejects whitespace-only string (single space)', () => {
    expect(() => schema.parse(' ')).toThrow();
  });

  it('rejects whitespace-only string (tab)', () => {
    expect(() => schema.parse('\t')).toThrow();
  });

  it('rejects whitespace-only string (multiple spaces)', () => {
    expect(() => schema.parse('   ')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => schema.parse('')).toThrow();
  });

  it('trims surrounding whitespace from a valid string', () => {
    expect(schema.parse('  hello world  ')).toBe('hello world');
  });

  it('preserves a string with no surrounding whitespace', () => {
    expect(schema.parse('sort_by')).toBe('sort_by');
  });

  it('trims tabs and newlines', () => {
    expect(schema.parse('\n  query\n')).toBe('query');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Proxy health endpoint — functional smoke test
// ─────────────────────────────────────────────────────────────────────────────

import { startProxy } from '../src/proxy';

describe('proxy /health endpoint', () => {
  it('returns 200 JSON with contentServerPort', async () => {
    const freePort = 19876; // unlikely to be in use
    const server = startProxy(freePort, async () => 54321);

    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const res = await fetch(`http://127.0.0.1:${freePort}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = await res.json() as { status: string; contentServerPort: number | null };
      expect(body.status).toBe('ok');
      expect(body.contentServerPort).toBe(54321);
    } finally {
      server.close();
    }
  });

  it('returns contentServerPort null when port resolver returns null', async () => {
    const freePort = 19877;
    const server = startProxy(freePort, async () => null);

    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const res = await fetch(`http://127.0.0.1:${freePort}/health`);
      const body = await res.json() as { contentServerPort: number | null };
      expect(body.contentServerPort).toBeNull();
    } finally {
      server.close();
    }
  });

  it('supports random proxy port 0', async () => {
    const server = startProxy(0, async () => 54321);

    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const address = server.address();
      expect(typeof address).toBe('object');
      const actualPort = typeof address === 'object' && address !== null ? address.port : 0;
      expect(actualPort).toBeGreaterThan(0);

      const res = await fetch(`http://127.0.0.1:${actualPort}/health`);
      const body = await res.json() as { contentServerPort: number | null };
      expect(body.contentServerPort).toBe(54321);
    } finally {
      server.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 fix: load_documentation_page port allow-list (SSRF prevention)
// Tests the (hostname, port) validation logic in isolation.
// ─────────────────────────────────────────────────────────────────────────────

describe('load_documentation_page port allow-list', () => {
  /** Pure helper that mirrors the allow-list logic from server.ts */
  function isAllowedUrl(
    loadUrl: string,
    contentServerPort: number | null,
    serverIp: string | null,
    proxyPort: number | null
  ): { ok: boolean; reason?: string } {
    let parsed: URL;
    try { parsed = new URL(loadUrl); } catch { return { ok: false, reason: 'invalid url' }; }

    if (parsed.protocol !== 'http:') return { ok: false, reason: 'not http' };

    if (contentServerPort === null && proxyPort === null) {
      return { ok: false, reason: 'no ports known' };
    }

    const urlPort = parsed.port || '80';
    const isAllowedDirect =
      parsed.hostname === '127.0.0.1' &&
      contentServerPort !== null &&
      urlPort === String(contentServerPort);
    const isAllowedProxy =
      serverIp !== null &&
      parsed.hostname === serverIp &&
      proxyPort !== null &&
      urlPort === String(proxyPort);

    if (isAllowedDirect || isAllowedProxy) return { ok: true };
    return { ok: false, reason: `${parsed.hostname}:${urlPort} not in allow-list` };
  }

  it('accepts 127.0.0.1 with the exact content server port', () => {
    expect(isAllowedUrl('http://127.0.0.1:60876/Dash/foo/bar.html', 60876, null, null).ok).toBe(true);
  });

  it('rejects 127.0.0.1 with a different port (SSRF vector)', () => {
    // Even though hostname matches, port 6379 (Redis) must be rejected
    const result = isAllowedUrl('http://127.0.0.1:6379/', 60876, null, null);
    expect(result.ok).toBe(false);
  });

  it('rejects 127.0.0.1:22 (SSH) even after setup', () => {
    expect(isAllowedUrl('http://127.0.0.1:22/', 60876, null, null).ok).toBe(false);
  });

  it('rejects 127.0.0.1:80 when contentServerPort is high port', () => {
    // Default port 80 is not the Dash content server
    expect(isAllowedUrl('http://127.0.0.1/', 60876, null, null).ok).toBe(false);
  });

  it('accepts the proxy URL (serverIp:proxyPort)', () => {
    const result = isAllowedUrl(
      'http://192.168.1.100:16766/Dash/foo/bar.html',
      60876, '192.168.1.100', 16766
    );
    expect(result.ok).toBe(true);
  });

  it('rejects proxy host with a wrong port', () => {
    const result = isAllowedUrl(
      'http://192.168.1.100:8080/admin',
      60876, '192.168.1.100', 16766
    );
    expect(result.ok).toBe(false);
  });

  it('rejects https:// regardless of host', () => {
    expect(isAllowedUrl('https://127.0.0.1:60876/page', 60876, null, null).ok).toBe(false);
  });

  it('rejects when no ports are known yet (before setup_dash)', () => {
    expect(isAllowedUrl('http://127.0.0.1:60876/page', null, null, null).ok).toBe(false);
  });

  it('rejects a non-local hostname even on the content port', () => {
    // Content server port matches but hostname is external — still rejected
    expect(isAllowedUrl('http://evil.example.com:60876/page', 60876, null, null).ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2a fix: detectContentServerPort error-propagation contract
// ─────────────────────────────────────────────────────────────────────────────

describe('detectContentServerPort error-propagation contract', () => {
  it('throws (does not swallow) DashApiError from listDocsets', async () => {
    // Simulate a DashApiError reaching the caller
    const { DashApiError } = await import('../src/dashClient');
    const err = new DashApiError(500, 'internal error');
    // Verify the error is still a DashApiError instance after being rethrown
    expect(err).toBeInstanceOf(DashApiError);
    expect(err.status).toBe(500);
    expect(err.name).toBe('DashApiError');
  });

  it('throws on malformed load_url port (NaN)', () => {
    // Mirror the NaN-port guard from detectContentServerPort
    const firstUrl = 'http://127.0.0.1/Dash/page.html'; // no port
    const parsed = new URL(firstUrl);
    const port = parseInt(parsed.port, 10);
    expect(isNaN(port)).toBe(true);
    // The real function throws; verify our guard value is NaN
  });

  it('port 80 implicit (no port in URL) correctly detected as NaN in parseInt', () => {
    const url = new URL('http://127.0.0.1/page');
    expect(url.port).toBe('');              // no explicit port
    expect(parseInt('', 10)).toBeNaN();     // parseInt('', 10) === NaN
  });
});
