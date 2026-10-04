/**
 * test_bizweb.js
 *
 * Regression: MBS migrated the Instagram inbox to a new "bizweb" surface
 * (rows wrapped in <span data-surface="/bizweb:inbox/…/thread_rowN">, no
 * selected_item_id anchors, dates in <abbr data-utime>, Done/Follow-up
 * buttons as <a role="row" href="#"> inside a ._4a51 role=grid cluster).
 *
 * The crawler used to find zero rows (Strategy A matched nothing) or
 * find rows but fail every navigation (every click strategy waited on a
 * selected_item_id URL change that never happens on bizweb).
 *
 * This file mirrors the production logic (getConversationItems'
 * Strategy BIZWEB, extractRowDate's Pass 0, isDangerousActionEl's
 * structural guards) and locks in the behaviour against a trimmed
 * fixture of the real bizweb DOM.
 */
'use strict';

const { JSDOM } = require('jsdom');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.error(`  ✗ FAIL: ${label}`); failed++; }
}

// ─── Fixture: trimmed real bizweb sidebar ────────────────────────────────────
// Three rows: Today (063), Today (MONARCH), Saturday (BetterMe) — plus a
// Done + Follow-up action grid on each. Only the fields the extension reads
// are kept; styling noise stripped.

const html = `<!DOCTYPE html><html><body style="width:1280px;height:800px">
  <div id="sidebar" style="width:360px;height:485px;overflow:auto;">
    <div style="height:846px;width:100%;position:relative;">

      <div style="position:absolute;left:0;top:0;height:94px;width:100%;">
        <div class="x1ypdohk" role="presentation" data-auto-logging-id="aid-063">
          <span data-surface-wrapper="1" data-surface="/bizweb:inbox/bizweb:INBOX/.../thread_row0">
            <div class="row">
              <span data-surface="/bizweb:inbox/.../thread_row0/lib:thread_title"><div>063</div></span>
              <div class="snippet">გამოხატა რეაქცია 🤍</div>
              <div class="ts">
                <span class="accessible_elem">დღეს</span>
                <abbr aria-hidden="true" class="timestamp" data-utime="1791104461.826" title="დღეს">13:01</abbr>
              </div>
              <div class="_4a51" role="grid" tabindex="-1">
                <div><a role="row" href="#"><div aria-label="გადატანა საქაღალდეში „მზადაა"" role="gridcell"></div></a></div>
                <div><a role="row" href="#"><div aria-label="გამოწერილად მონიშვნა" role="gridcell"></div></a></div>
              </div>
            </div>
          </span>
        </div>
      </div>

      <div style="position:absolute;left:0;top:94px;height:94px;width:100%;">
        <div class="x1ypdohk" role="presentation" data-auto-logging-id="aid-monarch">
          <span data-surface-wrapper="1" data-surface="/bizweb:inbox/bizweb:INBOX/.../thread_row1:priority">
            <div class="row">
              <span data-surface="/bizweb:inbox/.../thread_row1:priority/lib:thread_title"><div>MONARCH👑 | massage &amp; wellness</div></span>
              <div class="snippet">დიდი მადლობა…</div>
              <div class="ts">
                <span class="accessible_elem">დღეს</span>
                <abbr aria-hidden="true" class="timestamp" data-utime="1791104139.044" title="დღეს">12:55</abbr>
              </div>
              <div class="_4a51" role="grid" tabindex="-1">
                <div><a role="row" href="#"><div aria-label="გადატანა საქაღალდეში „მზადაა"" role="gridcell"></div></a></div>
                <div><a role="row" href="#"><div aria-label="გამოწერილად მონიშვნა" role="gridcell"></div></a></div>
              </div>
            </div>
          </span>
        </div>
      </div>

      <div style="position:absolute;left:0;top:188px;height:94px;width:100%;">
        <div class="x1ypdohk" role="presentation" data-auto-logging-id="aid-betterme">
          <span data-surface-wrapper="1" data-surface="/bizweb:inbox/bizweb:INBOX/.../thread_row2">
            <div class="row">
              <span data-surface="/bizweb:inbox/.../thread_row2/lib:thread_title"><div>BetterMe Store | BTTRM</div></span>
              <div class="snippet">თქვენ გაგზავნეთ დანართი.</div>
              <div class="ts">
                <span class="accessible_elem">შაბათი</span>
                <abbr aria-hidden="true" class="timestamp" data-utime="1791051294.965" title="შაბათი">შაბ</abbr>
              </div>
              <div class="_4a51" role="grid" tabindex="-1">
                <div><a role="row" href="#"><div aria-label="გადატანა საქაღალდეში „მზადაა"" role="gridcell"></div></a></div>
                <div><a role="row" href="#"><div aria-label="გამოწერილად მონიშვნა" role="gridcell"></div></a></div>
              </div>
            </div>
          </span>
        </div>
      </div>

    </div>
  </div>
</body></html>`;

const dom = new JSDOM(html, { pretendToBeVisual: true });
const { window } = dom;
const { document } = window;
Object.defineProperty(window, 'innerWidth',  { value: 1280, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 800,  configurable: true });

// Mock geometry: sidebar on the left (0..360), each row 94px tall.
// Critical: spans use style="display: contents" on the real page, so their
// getBoundingClientRect returns 0×0. Only the parent row div has layout.
document.querySelectorAll('[data-surface*="thread_row"]').forEach((span) => {
  span.getBoundingClientRect = () => ({ width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 });
});
Array.from(document.querySelectorAll('[data-surface*="thread_row"]'))
  .filter(s => /\/thread_row\d+(?::[a-z0-9_]+)?$/i.test(s.getAttribute('data-surface') || ''))
  .forEach((span, i) => {
  // span
  span.getBoundingClientRect = () => ({ width: 320, height: 70, left: 20, right: 340, top: i * 94 + 12, bottom: i * 94 + 82 });
  // its parent presentation div
  const row = span.parentElement;
  row.getBoundingClientRect = () => ({ width: 360, height: 94, left: 0, right: 360, top: i * 94, bottom: i * 94 + 94 });
  // the abbr for date pass-0 (right side ~ 300px from left)
  const abbr = row.querySelector('abbr[data-utime]');
  if (abbr) abbr.getBoundingClientRect = () => ({ width: 40, height: 16, left: 300, right: 340, top: i * 94 + 50, bottom: i * 94 + 66 });
  // action grid elements (make them clearly inside _4a51)
  row.querySelectorAll('._4a51 a, ._4a51 [role="gridcell"]').forEach(el => {
    el.getBoundingClientRect = () => ({ width: 24, height: 24, left: 320, right: 344, top: i * 94 + 35, bottom: i * 94 + 59 });
  });
});

// ─── Code mirrors ────────────────────────────────────────────────────────────
// Copied from content.js. Keep manually in sync with the production code.

function cleanText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

function extractRowName(el) {
  const titleNode = el.querySelector('[data-surface*="thread_title"]');
  if (titleNode) {
    const t = cleanText(titleNode);
    if (t) return t;
  }
  return null;
}

function isSidebarNotice() { return false; } // the fixture has none

function isDangerousActionEl(el) {
  try {
    if (el.closest('[role="grid"],[role="gridcell"]')) return true;
    if (el.closest('._4a51')) return true;
  } catch {}
  if (el.tagName === 'A' && el.getAttribute('role') === 'row') return true;
  return false;
}

function getConversationItemsBizweb(container) {
  const half = window.innerWidth / 2;
  const bizwebSpans = Array.from(container.querySelectorAll('[data-surface*="thread_row"]'))
    .filter(span => /\/thread_row\d+(?::[a-z0-9_]+)?$/i.test(span.getAttribute('data-surface') || ''));
  const seen = new Set();
  const items = [];
  for (const span of bizwebSpans) {
    // Mirrors content.js: measure the parent, not the display:contents span.
    const row = span.parentElement || span;
    const r = row.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0 && r.left < half)) continue;
    if (isSidebarNotice(row)) continue;
    const aid  = row.getAttribute('data-auto-logging-id')
              || span.getAttribute('data-auto-logging-id')
              || null;
    const name = extractRowName(row);
    if (!name) continue;
    const id = aid ? ('aid:' + aid) : ('fp:' + row.textContent.replace(/\s+/g, ' ').trim().slice(0, 80));
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, href: null, name, anchor: null, row, bizweb: true });
  }
  return items;
}

function extractRowDatePass0(row) {
  const abbr = row.querySelector('abbr.timestamp[data-utime], abbr[data-utime]');
  if (abbr) {
    const utime = parseFloat(abbr.getAttribute('data-utime'));
    if (!isNaN(utime) && utime > 1_262_304_000) {
      const d = new Date(utime * 1000);
      d.setHours(0, 0, 0, 0);
      return d;
    }
  }
  return null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const sidebar = document.getElementById('sidebar');
const items = getConversationItemsBizweb(sidebar);

console.log('\n=== Bizweb row discovery ===');
assert(items.length === 3, `expected 3 rows, got ${items.length}`);
assert(items[0].id === 'aid:aid-063',      `row 0 id uses data-auto-logging-id: ${items[0].id}`);
assert(items[1].id === 'aid:aid-monarch',  `row 1 id uses data-auto-logging-id: ${items[1].id}`);
assert(items[2].id === 'aid:aid-betterme', `row 2 id uses data-auto-logging-id: ${items[2].id}`);
assert(items[0].name === '063',                              `row 0 name: ${items[0].name}`);
assert(items[1].name === 'MONARCH👑 | massage & wellness',   `row 1 name: ${items[1].name}`);
assert(items[2].name === 'BetterMe Store | BTTRM',           `row 2 name: ${items[2].name}`);
assert(items.every(i => i.href === null),   'bizweb items have href=null');
assert(items.every(i => i.bizweb === true), 'bizweb items are flagged');

console.log('\n=== extractRowDate Pass 0: data-utime ===');
const d0 = extractRowDatePass0(items[0].row);
assert(d0 instanceof Date && !isNaN(d0.getTime()), `pass-0 returns a valid Date for row 0 (got ${d0})`);
const expected0 = new Date(1791104461.826 * 1000); expected0.setHours(0,0,0,0);
assert(d0 && d0.getTime() === expected0.getTime(), `pass-0 matches data-utime (${d0 && d0.toISOString()})`);

console.log('\n=== Done/Follow-up action buttons are dangerous ===');
const row0 = items[0].row;
const doneAnchor      = row0.querySelector('._4a51 a[role="row"]');
const doneGridcell    = row0.querySelector('._4a51 [role="gridcell"]');
assert(isDangerousActionEl(doneAnchor),   'a[role="row"] Done anchor flagged dangerous');
assert(isDangerousActionEl(doneGridcell), '[role="gridcell"] inside _4a51 flagged dangerous');
assert(!isDangerousActionEl(row0),        'row itself is not flagged dangerous');

console.log('\n=== 2001-09-09 sentinel rejection (regression) ===');
// MIN_YEAR guard: parseDateLabel('2001-09-09…') must return null.
// Mirrors the guard in utils.js:234. Not strictly a bizweb test but ships
// in the same fix window.
function parseDateLabelNative(raw) {
  const native = new Date(raw);
  const MIN_YEAR = 2010;
  if (!isNaN(native.getTime()) && native.getFullYear() >= MIN_YEAR) {
    native.setHours(0, 0, 0, 0);
    return native;
  }
  return null;
}
assert(parseDateLabelNative('2001-09-09T01:46:40.000Z') === null,
  '2001-09-09 Unix-billion-second sentinel is rejected');
assert(parseDateLabelNative('2026-10-04T12:00:00.000Z') instanceof Date,
  'legitimate 2026 ISO datetime still parses');

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
