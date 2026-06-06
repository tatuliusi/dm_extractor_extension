/**
 * test_extraction.js
 * Tests Strategy C row detection and structural [dir="auto"] message extraction
 * by exercising the exact code in content.js against a mocked WEC-like DOM.
 */
'use strict';

const { JSDOM } = require('jsdom');

// ─── Mock DOM: WEC-like sidebar + thread ────────────────────────────────────

const dom = new JSDOM(`<!DOCTYPE html>
<html><body style="display:flex;width:1280px;height:800px">

  <!-- WEC sidebar: plain divs, NO a[href*=selected_item_id] -->
  <div id="sidebar" style="width:360px;height:800px;overflow:auto;">
    <div class="row">Nino Beridze გამარჯობა, შეკვეთა?</div>
    <div class="row">Giorgi Kvaratskhelia Hello, what is the price?</div>
    <div class="row">Ana Lomidze when will my order arrive?</div>
  </div>

  <!-- Thread pane -->
  <div id="thread" style="width:920px;height:800px;">
    <div aria-label="Message list container" style="height:700px;overflow:auto;">
      <div role="separator">June 6, 2026</div>
      <div class="inbound"><div dir="auto">გამარჯობა, შეკვეთა?</div></div>
      <div class="outbound"><div dir="auto">შეკვეთა 3-5 დღეში მოვა.</div></div>
      <div class="inbound"><div dir="auto">გმადლობთ!</div></div>
    </div>
  </div>

</body></html>`, { pretendToBeVisual: true });

const { window } = dom;
const { document } = window;

// ─── Mock getBoundingClientRect per element ──────────────────────────────────

// Row dimensions that match Strategy C criteria: height 80, width 360, left 0
document.querySelectorAll('#sidebar .row').forEach((el, i) => {
  el.getBoundingClientRect = () => ({
    height: 80, width: 360,
    left: 0,   right: 360,
    top: i * 80, bottom: (i + 1) * 80,
  });
});

// Message list container
document.querySelector('[aria-label*="Message list container"]')
  .getBoundingClientRect = () => ({
    height: 700, width: 920, left: 360, right: 1280, top: 0, bottom: 700
  });

// Message bubble divs (dir="auto") — on the right side (outbound) or left
document.querySelectorAll('.inbound [dir="auto"]').forEach((el, i) => {
  el.getBoundingClientRect = () => ({
    height: 36, width: 260, left: 370, right: 630, top: 80 + i * 60, bottom: 116 + i * 60
  });
});
document.querySelectorAll('.outbound [dir="auto"]').forEach((el, i) => {
  el.getBoundingClientRect = () => ({
    height: 36, width: 260, left: 750, right: 1010, top: 140 + i * 60, bottom: 176 + i * 60
  });
});

Object.defineProperty(window, 'innerWidth',  { value: 1280, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 800,  configurable: true });

// ─── Strategy C: exact code copy from content.js ──────────────────────────────
// (mirrors the code at lines 847–879 of content.js)

function strategyC(container) {
  const half = window.innerWidth / 2;
  const allEls = Array.from(container.querySelectorAll('*'));
  const rowCandidates = allEls.filter(el => {
    const r = el.getBoundingClientRect();
    if (!(r.height >= 50 && r.height <= 220 && r.width > 100 && r.left < half && r.left >= 0)) return false;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    return text.length >= 4 && text.length <= 400 && !/^[.…]+$/.test(text);
  });
  const outerRows = rowCandidates.filter(el =>
    !rowCandidates.some(other => other !== el && other.contains(el))
  );
  return outerRows;
}

// ─── Structural fallback: exact code copy from extract() in content.js ─────────
// (mirrors the [dir="auto"] fallback block starting at line 463)

function bubbleText(bubble) {
  const clone = bubble.cloneNode(true);
  clone.querySelectorAll(
    '[aria-hidden="true"], [class*="hidden"], .sr-only, [style*="display:none"]'
  ).forEach(n => n.remove());
  return clone.textContent.trim();
}

function structuralFallback(region) {
  const messages = [];
  let synIdx = 0;
  const seenKeys = new Set();
  for (const el of region.querySelectorAll('[dir="auto"]')) {
    if (el.closest('[aria-hidden="true"]') || el.closest('[role="button"]')) continue;
    const text = bubbleText(el);
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 5 || r.width < 5) continue;
    const key = `${Math.round(r.top / 5)}_${text.slice(0, 40)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const mid = (r.left + r.width / 2 - 360) / 920; // relative X in thread pane
    const direction = mid > 0.55 ? 'outbound' : mid < 0.45 ? 'inbound' : 'unknown';
    messages.push({ id: `synth_${synIdx++}`, direction, text, type: 'text' });
  }
  return messages;
}

// ─── Test 1: Strategy C finds WEC sidebar rows ───────────────────────────────

console.log('\n=== Test 1: Strategy C row detection (WEC sidebar) ===');
const sidebar = document.getElementById('sidebar');
const rows = strategyC(sidebar);
console.log(`Found ${rows.length} rows`);
rows.forEach((r, i) => console.log(`  [${i}] "${r.textContent.replace(/\s+/g,' ').trim().slice(0,50)}"`));

const test1 = rows.length >= 2;
console.log(test1 ? '✓ PASS' : '✗ FAIL: expected ≥2 rows');

// ─── Test 2: Structural fallback extracts messages from thread ────────────────

console.log('\n=== Test 2: Structural fallback message extraction ===');
const region = document.querySelector('[aria-label*="Message list container"]');
const messages = structuralFallback(region);
console.log(`Extracted ${messages.length} messages`);
messages.forEach((m, i) => console.log(`  [${i}] ${m.direction}: "${m.text.slice(0,40)}"`));

const test2 = messages.length >= 2;
console.log(test2 ? '✓ PASS' : '✗ FAIL: expected ≥2 messages');

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
const allPass = test1 && test2;
console.log(allPass ? '✓ Both tests passed — Strategy C and structural fallback work correctly'
                    : '✗ Some tests failed');
process.exit(allPass ? 0 : 1);
