/**
 * HTML parsing, section extraction, and Markdown conversion utilities.
 * Ported and improved from the reference Python implementation.
 */

import { load as cheerioLoad } from 'cheerio';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});
turndown.use(gfm); // adds proper GFM table, strikethrough, and task-list support

// ---------------------------------------------------------------------------
// parseFragment
// ---------------------------------------------------------------------------

/**
 * Extracts the anchor ID from a Dash load_url fragment.
 *
 * Dash uses a special format:  #//dash_ref_{html-id}/Type/Name/Index
 * Regular anchor:              #some-anchor
 *
 * @returns The anchor id string, or null if no (meaningful) fragment.
 */
export function parseFragment(loadUrl: string): string | null {
  let fragment: string;
  try {
    const url = new URL(loadUrl);
    // url.hash includes the leading '#'; decode percent-encoding
    fragment = decodeURIComponent(url.hash.slice(1));
  } catch {
    return null;
  }
  if (!fragment) return null;

  if (fragment.startsWith('//dash_ref_')) {
    const anchor = fragment.slice('//dash_ref_'.length).split('/')[0];
    return anchor || null;
  }
  return fragment;
}

// ---------------------------------------------------------------------------
// extractSection
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set(['div', 'section', 'article', 'li']);
const THIN_TAGS = new Set(['a', 'span']);
const NOISE_TAGS = ['nav', 'aside', 'header', 'footer'];

/**
 * Extracts a focused section of an HTML document.
 *
 * With anchorId: finds the element with that id and returns it.
 * If the matched element is a thin element (a/span used as an anchor),
 * walks up to the nearest block-level parent.
 * Falls back to nav-stripping if the anchor is not found or no suitable
 * block parent exists.
 *
 * Without anchorId: removes nav/sidebar noise and returns the body.
 */
export function extractSection(html: string, anchorId: string | null): string {
  const $ = cheerioLoad(html);

  if (anchorId) {
    // Use attribute selector to avoid CSS-escaping edge cases with special chars in IDs
    const initial = $('[id]')
      .filter(function () {
        return $(this).attr('id') === anchorId;
      })
      .first();

    if (initial.length > 0) {
      const tagName = (initial.prop('tagName') as string).toLowerCase();
      let resultEl = initial;

      if (THIN_TAGS.has(tagName)) {
        // Walk up to the nearest block-level parent
        initial.parents().each(function () {
          const pTag = ((this as unknown as { tagName: string }).tagName ?? '').toLowerCase();
          if (BLOCK_TAGS.has(pTag)) {
            resultEl = $(this);
            return false; // break cheerio .each
          }
        });
      }

      const resultTag = (resultEl.prop('tagName') as string).toLowerCase();
      if (!THIN_TAGS.has(resultTag)) {
        return $.html(resultEl);
      }
      // Still thin (no block parent found) — fall through to nav-stripping
    }
    // Anchor not found — fall through to nav-stripping
  }

  // Strip navigation/sidebar noise and return the body
  $(NOISE_TAGS.join(', ')).remove();
  const body = $('body');
  return body.length > 0 ? $.html(body) : $.html();
}

// ---------------------------------------------------------------------------
// htmlToText
// ---------------------------------------------------------------------------

/** Converts HTML to Markdown using turndown. */
export function htmlToText(html: string): string {
  return turndown.turndown(html);
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

/**
 * Rough token estimate for a serialised value.
 * Approximation: 1 token ≈ 4 characters.
 */
export function estimateTokens(obj: unknown): number {
  if (typeof obj === 'string') {
    return Math.max(1, Math.floor(obj.length / 4));
  }
  if (Array.isArray(obj)) {
    return (obj as unknown[]).reduce<number>((sum, item) => sum + estimateTokens(item), 0);
  }
  if (obj !== null && typeof obj === 'object') {
    return Object.entries(obj as Record<string, unknown>).reduce(
      (sum, [k, v]) => sum + estimateTokens(k) + estimateTokens(v),
      0
    );
  }
  return Math.max(1, Math.floor(String(obj).length / 4));
}
