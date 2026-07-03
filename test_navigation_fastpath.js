/**
 * test_navigation_fastpath.js
 *
 * Regression: the first conversation used to hang ~45 s before failing with
 * "Could not navigate to: X — skipping" whenever the sidebar's first row was
 * already open in the thread pane AND the URL had no selected_item_id param.
 *
 * navigateToConversation's fast-path and final-fallback both used a name-match
 * check to detect "already-selected", but they GATED the check on the URL
 * carrying selected_item_id. Meta's Instagram inbox commonly omits that param
 * (see the real per-Page URLs supplied by the user for lolita and cafe
 * stamba), so the guards short-circuited, every click strategy timed out, and
 * navigateToConversation returned false.
 *
 * Fix: drop the id requirement. This file exercises the pure predicate to
 * lock in the new behaviour.
 */
'use strict';

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

// ─── Pure predicate lifted from content.js:navigateToConversation fast-path ──
// (kept in sync manually; behaviour must match the production check exactly).

function isAlreadySelected({ rowName, headerName }) {
  if (!rowName) return false;
  const row    = String(rowName).trim().toLowerCase();
  const header = String(headerName || '').trim().toLowerCase();
  if (!row || !header || row.length < 2) return false;
  return header.includes(row) || row.includes(header);
}

// ─── The real regression: no URL id + names match → already selected ─────────

console.log('\n=== Regression: no selected_item_id in URL but names match ===');

assert(isAlreadySelected({ rowName: 'Pavel Polyakov', headerName: 'Pavel Polyakov' }) === true,
  'row "Pavel Polyakov" matches header "Pavel Polyakov" — fast-path fires');

assert(isAlreadySelected({ rowName: 'Ks Ks', headerName: 'Ks Ks' }) === true,
  'row "Ks Ks" matches header "Ks Ks"');

// Partial matches: sidebar shows short display name, header shows full name
assert(isAlreadySelected({ rowName: 'kovnurochka', headerName: 'kovnurochka (Nino B)' }) === true,
  'header contains row name → fast-path fires');
assert(isAlreadySelected({ rowName: 'kovnurochka (Nino B)', headerName: 'kovnurochka' }) === true,
  'row contains header name → fast-path fires');

// ─── Mismatches must NOT fire the fast-path ─────────────────────────────────

console.log('\n=== Different names → fall through to normal navigation ===');

assert(isAlreadySelected({ rowName: 'Pavel Polyakov', headerName: 'Ks Ks' }) === false,
  'different names do NOT match');

assert(isAlreadySelected({ rowName: 'kovnurochka', headerName: 'Pavel Polyakov' }) === false,
  'unrelated names do NOT match');

// ─── Guardrails ──────────────────────────────────────────────────────────────

console.log('\n=== Guardrails: empties and single-char rows are rejected ===');

assert(isAlreadySelected({ rowName: '', headerName: 'Pavel Polyakov' }) === false,
  'empty row name → false');

assert(isAlreadySelected({ rowName: 'Pavel', headerName: '' }) === false,
  'empty header → false (nothing to compare against, avoids stale-header false-positives)');

assert(isAlreadySelected({ rowName: null, headerName: 'Pavel' }) === false,
  'null row → false');

assert(isAlreadySelected({ rowName: 'Pavel', headerName: null }) === false,
  'null header → false');

// A single-letter row name is too weak to base a match on
assert(isAlreadySelected({ rowName: 'K', headerName: 'Kovnurochka' }) === false,
  'single-char row name rejected (would false-match too easily)');

assert(isAlreadySelected({ rowName: 'Ks', headerName: 'Ks Ks' }) === true,
  'two-char row name accepted (real IG usernames can be short)');

// Case-insensitive
assert(isAlreadySelected({ rowName: 'PAVEL POLYAKOV', headerName: 'pavel polyakov' }) === true,
  'case-insensitive match');

// Whitespace
assert(isAlreadySelected({ rowName: '  Pavel Polyakov  ', headerName: 'Pavel Polyakov' }) === true,
  'row name whitespace trimmed');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.error('✗ Some tests failed');
  process.exit(1);
} else {
  console.log('✓ All tests passed');
  process.exit(0);
}
