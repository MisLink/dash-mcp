#!/usr/bin/env node
/**
 * Integration test script: sends MCP JSON-RPC messages via stdio transport
 * and validates tool call responses.
 *
 * Run:  node test_tools.mjs
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// ── Spawn the MCP server ───────────────────────────────────────────────────
const server = spawn('node', ['dist/index.js', '--transport', 'stdio'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = createInterface({ input: server.stdout });
const pending = new Map();

// Parse server responses
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  } catch { /* ignore non-JSON lines */ }
});

function call(id, method, params = {}) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function callTool(id, name, args = {}) {
  return call(id, 'tools/call', { name, arguments: args });
}

function parseToolResult(response) {
  const text = response?.result?.content?.[0]?.text;
  if (!text) throw new Error('No text content in response: ' + JSON.stringify(response));
  return JSON.parse(text);
}

let failures = 0;

function check(label, actual, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label} — got: ${JSON.stringify(actual)}`);
    failures++;
  }
}

// ── Run tests ─────────────────────────────────────────────────────────────
const initResp = await call(1, 'initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'integration-test', version: '1' },
});
check('initialize handshake', initResp.result?.serverInfo?.name, initResp.result?.serverInfo?.name === 'Dash Documentation API');

// ── Step 5: list_installed_docsets before setup → error ────────────────────
console.log('\n[Step 5] list_installed_docsets before setup_dash → error');
const step5 = parseToolResult(await callTool(2, 'list_installed_docsets'));
check('has error field', step5, typeof step5.error === 'string' && step5.error.includes('setup_dash'));
check('docsets is empty array', step5.docsets, Array.isArray(step5.docsets) && step5.docsets.length === 0);
check('no success crash', step5, !step5.success);

// ── Step 6: setup_dash → Dash starts, API ready ────────────────────────────
console.log('\n[Step 6] setup_dash → Dash API ready');
const step6 = parseToolResult(await callTool(3, 'setup_dash'));
check('success is true', step6, step6.success === true);
check('dashApiUrl present', step6.dashApiUrl, typeof step6.dashApiUrl === 'string' && step6.dashApiUrl.startsWith('http://127.0.0.1'));
check('no error field on success', step6, !step6.error);
console.log('  ℹ️  Dash API URL:', step6.dashApiUrl);

// ── Discover first installed docset to use in remaining tests ─────────────
const listResp = parseToolResult(await callTool(4, 'list_installed_docsets'));
const firstDocset = listResp.docsets?.[0];
if (!firstDocset) {
  console.log('  ⚠️  No docsets installed — skipping search tests');
  server.kill(); process.exit(0);
}
const docsetId = firstDocset.identifier;
const docsetName = firstDocset.name;
console.log(`\n  Using docset: ${docsetName} (${docsetId})`);

// ── Step 7: search_documentation with docsetIdentifiers as array ──────────
console.log(`\n[Step 7] search_documentation — docsetIdentifiers as array ["${docsetId}"]`);
const step7 = parseToolResult(await callTool(5, 'search_documentation', {
  query: 'get',
  docsetIdentifiers: [docsetId],
  maxResults: 5,
}));
check('results is array', step7.results, Array.isArray(step7.results));
check('truncated field present', step7, 'truncated' in step7);
check('no error on clean search', step7, !step7.error);
if (step7.results.length > 0) {
  const first = step7.results[0];
  check('result has name',     first.name,     typeof first.name === 'string');
  check('result has load_url', first.load_url, typeof first.load_url === 'string');
}
console.log(`  ℹ️  Got ${step7.results.length} results, truncated=${step7.truncated}`);

// ── Step 8: search with warning → warning field, not error ────────────────
console.log('\n[Step 8] warning field separate from error');
// Search with FTS disabled may return a Dash warning message
const step8 = parseToolResult(await callTool(6, 'search_documentation', {
  query: 'list',
  docsetIdentifiers: [docsetId],
  maxResults: 3,
}));
if (step8.warning) {
  check('warning is in warning field (not error)', step8, typeof step8.warning === 'string');
  check('error field absent when only a warning', step8, !step8.error);
  console.log('  ℹ️  Dash warning:', step8.warning);
} else {
  check('no spurious warning', step8, step8.warning === undefined);
  console.log('  ℹ️  No Dash warning (FTS may already be enabled) — structure correct');
}

// ── Step 9: truncation metadata ───────────────────────────────────────────
console.log('\n[Step 9] truncation metadata in response');
// Request many results to trigger truncation; use a very broad single-char query
const step9 = parseToolResult(await callTool(7, 'search_documentation', {
  query: 'a',
  docsetIdentifiers: [docsetId],
  maxResults: 1000,
}));
check('truncated field is boolean', step9, typeof step9.truncated === 'boolean');
if (step9.truncated) {
  check('truncatedCount > 0',         step9.truncatedCount,   step9.truncatedCount > 0);
  check('truncationNotice is string', step9.truncationNotice, typeof step9.truncationNotice === 'string');
  console.log(`  ℹ️  Truncated: showing ${step9.results.length}, omitted ${step9.truncatedCount}`);
} else {
  console.log('  ℹ️  Results fit within token limit — not truncated');
}

// ── Step 10: enable_docset_fts failure → structured error, not bare false ─
console.log('\n[Step 10] enable_docset_fts with bad identifier → structured error');
const step10 = parseToolResult(await callTool(8, 'enable_docset_fts', {
  identifier: 'definitely-does-not-exist-zzz',
}));
check('response is object (not bare false)', step10, typeof step10 === 'object' && step10 !== null);
check('success is false', step10, step10.success === false);
check('error field present with guidance', step10.error, typeof step10.error === 'string' && step10.error.length > 0);
check('identifier echoed back', step10.identifier, step10.identifier === 'definitely-does-not-exist-zzz');
console.log('  ℹ️  Error message:', step10.error);

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50));
if (failures === 0) {
  console.log('✅ All integration checks passed');
} else {
  console.error(`❌ ${failures} check(s) failed`);
}
server.kill();
process.exit(failures > 0 ? 1 : 0);
