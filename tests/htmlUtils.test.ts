/**
 * Unit tests for htmlUtils — ported from the Python reference implementation
 * and extended with additional edge cases.
 */

import { describe, it, expect } from 'vitest';
import { parseFragment, extractSection } from '../src/htmlUtils';

// ─────────────────────────────────────────────────────────────────────────────
// parseFragment
// ─────────────────────────────────────────────────────────────────────────────

describe('parseFragment', () => {
  it('parses Dash-style fragment (percent-encoded)', () => {
    const url =
      'http://127.0.0.1:1234/Dash/abc/Enumerable.html' +
      '#//dash_ref_method%2Di%2Dsort%5Fby/Method/sort_by/0';
    expect(parseFragment(url)).toBe('method-i-sort_by');
  });

  it('parses plain anchor fragment', () => {
    const url = 'http://127.0.0.1:1234/page.html#some-anchor';
    expect(parseFragment(url)).toBe('some-anchor');
  });

  it('returns null when there is no fragment', () => {
    const url = 'http://127.0.0.1:1234/page.html';
    expect(parseFragment(url)).toBeNull();
  });

  it('returns null for an empty fragment (#)', () => {
    const url = 'http://127.0.0.1:1234/page.html#';
    expect(parseFragment(url)).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(parseFragment('not a url')).toBeNull();
  });

  it('returns null when Dash ref has empty anchor id', () => {
    const url = 'http://127.0.0.1:1234/page.html#//dash_ref_/Type/Name/0';
    expect(parseFragment(url)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSection
// ─────────────────────────────────────────────────────────────────────────────

const FULL_PAGE = `
<html><body>
  <nav><a href="/">Home</a><a href="/docs">Docs</a></nav>
  <aside class="sidebar"><ul><li>Item</li></ul></aside>
  <div id="method-i-sort_by">
    <h2>sort_by</h2>
    <p>Sorts by the block return value.</p>
  </div>
  <div id="method-i-map">
    <h2>map</h2>
    <p>Maps elements.</p>
  </div>
</body></html>
`;

describe('extractSection', () => {
  it('extracts only the section matching the anchor', () => {
    const result = extractSection(FULL_PAGE, 'method-i-sort_by');
    expect(result).toContain('sort_by');
    expect(result).toContain('Sorts by the block return value');
    expect(result).not.toContain('Maps elements');
  });

  it('strips <nav> when no anchor is given', () => {
    const result = extractSection(FULL_PAGE, null);
    expect(result).not.toContain('<nav>');
    expect(result).not.toContain('Home');
  });

  it('strips <aside> (sidebar) when no anchor is given', () => {
    const result = extractSection(FULL_PAGE, null);
    expect(result).not.toContain('sidebar');
    expect(result).not.toContain('<aside');
  });

  it('keeps content sections when no anchor is given', () => {
    const result = extractSection(FULL_PAGE, null);
    expect(result).toContain('sort_by');
    expect(result).toContain('Maps elements');
  });

  it('falls back to nav-stripping when the anchor is not found', () => {
    const result = extractSection(FULL_PAGE, 'nonexistent-anchor');
    expect(result).not.toContain('<nav>');
    expect(result).toContain('sort_by');
  });

  it('walks up from a thin <a> element to the nearest block parent', () => {
    const html = `
      <html><body>
        <div id="method-wrapper">
          <a id="method-i-foo"></a>
          <h2>foo</h2>
          <p>Foo description.</p>
        </div>
      </body></html>
    `;
    const result = extractSection(html, 'method-i-foo');
    expect(result).toContain('Foo description');
  });

  it('falls back to nav-stripping when thin element has no block parent', () => {
    const html = `
      <html><body>
        <nav><a href="/">Home</a></nav>
        <a id="orphan-anchor"></a>
        <p>Content with no block wrapper.</p>
      </body></html>
    `;
    const result = extractSection(html, 'orphan-anchor');
    expect(result).not.toContain('<nav>');
    expect(result).toContain('Content with no block wrapper');
  });

  it('walks up from a thin <span> element', () => {
    const html = `
      <html><body>
        <section id="wrapper">
          <span id="anchor-span"></span>
          <p>Span parent content.</p>
        </section>
      </body></html>
    `;
    const result = extractSection(html, 'anchor-span');
    expect(result).toContain('Span parent content');
  });

  it('returns body content when no body tag is present', () => {
    const html = '<div id="only"><p>Only content.</p></div>';
    const result = extractSection(html, null);
    expect(result).toContain('Only content');
  });

  // ─── additional edge cases ────────────────────────────────────────────────

  it('handles completely empty HTML string', () => {
    expect(() => extractSection('', null)).not.toThrow();
  });

  it('handles HTML with no body and anchor', () => {
    const html = '<div id="target"><p>Content.</p></div>';
    const result = extractSection(html, 'target');
    expect(result).toContain('Content');
  });

  it('returns meaningful content when anchor matches a div with nested content', () => {
    const html = `
      <html><body>
        <div id="api-section">
          <h2>API Reference</h2>
          <p>Full API documentation.</p>
          <ul><li>method1</li><li>method2</li></ul>
        </div>
        <div id="other-section"><p>Other content.</p></div>
      </body></html>
    `;
    const result = extractSection(html, 'api-section');
    expect(result).toContain('API Reference');
    expect(result).toContain('method1');
    expect(result).not.toContain('Other content');
  });

  it('strips multiple noise elements when no anchor given', () => {
    const html = `
      <html><body>
        <header><h1>Site Title</h1></header>
        <nav><a href="/">Home</a></nav>
        <aside>Sidebar content</aside>
        <main><p>Main content here.</p></main>
        <footer>Footer text</footer>
      </body></html>
    `;
    const result = extractSection(html, null);
    expect(result).not.toContain('Site Title');    // header stripped
    expect(result).not.toContain('Home');           // nav stripped
    expect(result).not.toContain('Sidebar');        // aside stripped
    expect(result).not.toContain('Footer text');    // footer stripped
    expect(result).toContain('Main content here'); // main preserved
  });

  it('handles <article> as a block parent for thin anchor elements', () => {
    const html = `
      <html><body>
        <article id="article-wrap">
          <a id="article-anchor"></a>
          <h2>Article Title</h2>
          <p>Article body.</p>
        </article>
      </body></html>
    `;
    const result = extractSection(html, 'article-anchor');
    expect(result).toContain('Article Title');
    expect(result).toContain('Article body');
  });
});
