/**
 * test_operator_name.js
 * Verifies parseAssignmentText() extracts the operator name from the various
 * "assigned to X" phrasings Meta Business Suite emits, plus that the
 * findAssignmentLabel DOM scan picks up a live "Assigned to X" element.
 */
'use strict';

const { JSDOM } = require('jsdom');

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

// ─── Inline copies from content.js (kept in sync manually) ───────────────────

function parseAssignmentText(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/\s+/g, ' ').trim();

  const strip = raw => raw
    .replace(/\s+by\s+.+$/i, '')
    .replace(/\s+this conversation.*$/i, '')
    .replace(/[.!?,;:]+$/, '')
    .trim();

  const m2 = cleaned.match(/^(.+?)\s+(?:was|has been|is)\s+(?:(?:re)?assigned|taken|picked up)/i);
  if (m2) {
    const n = strip(m2[1]);
    if (n) return n;
  }

  const m1 = cleaned.match(/(?:^|\W)(?:re)?assigned(?:\s+to)?\s+(.+?)$/i);
  if (m1) {
    const n = strip(m1[1]);
    if (n) return n;
  }

  const m3 = cleaned.match(/^(.+?)-?ს\s*მიენიჭა/);
  if (m3) {
    const n = strip(m3[1]);
    if (n) return n;
  }

  return null;
}

function findAssignmentLabel(document) {
  const patterns = [
    /^\s*assigned\s+to\s+(.+?)\s*$/i,
    /^\s*reassigned\s+to\s+(.+?)\s*$/i,
    /^(.+?)-?ს\s*მიენიჭა/,
  ];
  for (const el of document.querySelectorAll('span, div, p, small')) {
    if (el.children.length > 2) continue;
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 120) continue;
    for (const re of patterns) {
      const m = t.match(re);
      if (m && m[1]) {
        const name = m[1].replace(/[.!?,;:]+$/, '').trim();
        if (name && name.length <= 80) return name;
      }
    }
  }
  return null;
}

// ─── Test 1: parseAssignmentText — English phrasings ────────────────────────

console.log('\n=== Test: parseAssignmentText English variants ===');

assert(parseAssignmentText('Assigned to Talia Doidzee') === 'Talia Doidzee',
  '"Assigned to Talia Doidzee" → Talia Doidzee');

assert(parseAssignmentText('Assigned to Talia Doidzee.') === 'Talia Doidzee',
  'trailing period stripped');

assert(parseAssignmentText('Reassigned to Ana Lomidze') === 'Ana Lomidze',
  '"Reassigned to Ana Lomidze" → Ana Lomidze');

assert(parseAssignmentText('Talia Doidzee was assigned to this conversation') === 'Talia Doidzee',
  '"X was assigned to this conversation" → X');

assert(parseAssignmentText('John Smith has been assigned') === 'John Smith',
  '"X has been assigned" → X');

assert(parseAssignmentText('Talia Doidzee was assigned to this conversation by Manager Bob') === 'Talia Doidzee',
  '"by <manager>" clause stripped');

assert(parseAssignmentText('Assigned to Jean-Luc Picard') === 'Jean-Luc Picard',
  'hyphenated name preserved');

assert(parseAssignmentText('Assigned to María González') === 'María González',
  'diacritics preserved');

// ─── Test 2: parseAssignmentText — non-assignment text returns null ─────────

console.log('\n=== Test: parseAssignmentText ignores non-assignment text ===');

assert(parseAssignmentText('Hello, how can I help?') === null,
  'unrelated greeting → null');

assert(parseAssignmentText('') === null, 'empty string → null');
assert(parseAssignmentText(null) === null, 'null input → null');
assert(parseAssignmentText(undefined) === null, 'undefined input → null');

assert(parseAssignmentText('Ali was assigned a task') === 'Ali',
  '"assigned a task" still matches (was assigned) — acceptable false positive');

// ─── Test 3: parseAssignmentText — Georgian phrasing ────────────────────────

console.log('\n=== Test: parseAssignmentText Georgian ===');

assert(parseAssignmentText('თალია დოიძეს მიენიჭა') === 'თალია დოიძე',
  'Georgian "X-ს მიენიჭა" → X (stem)');

// ─── Test 4: findAssignmentLabel DOM fallback ───────────────────────────────

console.log('\n=== Test: findAssignmentLabel DOM fallback ===');

const dom = new JSDOM(`<!DOCTYPE html><html><body>
  <div id="thread">
    <div class="header">
      <span>Instagram</span>
      <span class="assignment-pill">Assigned to Talia Doidzee</span>
    </div>
    <div class="message">Hello there!</div>
  </div>
</body></html>`);

const name = findAssignmentLabel(dom.window.document);
assert(name === 'Talia Doidzee', `DOM scan finds "Talia Doidzee": got "${name}"`);

// Also ensure it returns null when no assignment pill is present
const dom2 = new JSDOM(`<!DOCTYPE html><html><body>
  <div>Just some ordinary text with no assignment info.</div>
</body></html>`);
assert(findAssignmentLabel(dom2.window.document) === null,
  'no assignment pill → null');

// And that oversized text blocks (>120 chars) are ignored to avoid grabbing
// the whole page paragraph containing "assigned to"
const dom3 = new JSDOM(`<!DOCTYPE html><html><body>
  <p>${'x'.repeat(200)} assigned to Somebody ${'y'.repeat(200)}</p>
</body></html>`);
assert(findAssignmentLabel(dom3.window.document) === null,
  'over-long paragraph rejected (>120 chars)');

// ─── Test 5: Latest-assignment wins (integration-style) ─────────────────────

console.log('\n=== Test: latest system_event wins when multiple assignments ===');

function pickOperator(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== 'system_event') continue;
    const parsed = parseAssignmentText(m.text);
    if (parsed) return parsed;
  }
  return null;
}

const msgs = [
  { type: 'system_event', text: 'Assigned to First Person' },
  { type: 'text', text: 'Hello' },
  { type: 'system_event', text: 'Reassigned to Second Person' },
  { type: 'text', text: 'What a nice day' },
  { type: 'system_event', text: 'Conversation was archived' }, // not an assignment
];
assert(pickOperator(msgs) === 'Second Person',
  'reverse walk finds latest assignment, ignores archive event');

assert(pickOperator([{ type: 'text', text: 'no system events here' }]) === null,
  'no system_event → null');

// ─── Summary ───────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.error('✗ Some tests failed');
  process.exit(1);
} else {
  console.log('✓ All tests passed');
  process.exit(0);
}
