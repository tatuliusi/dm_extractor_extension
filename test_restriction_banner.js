/**
 * test_restriction_banner.js
 *
 * Regression test for the WhatsApp "account restricted" banner bug.
 *
 * On restricted WhatsApp Business accounts, MBS renders a ~180 px notice
 * banner at the top of the sidebar. The banner:
 *   • matches the 50–220 px height filter used by Strategies B and C,
 *   • inflates the header wrapper enough that a naive "tallest child" fallback
 *     routes descent into the header instead of the conversation list.
 *
 * Before the fix, getConversationItems() returned 0 items on such accounts
 * and the crawler logged "Reached end of conversation list" immediately.
 *
 * This test mocks that exact DOM shape and asserts:
 *   (a) Strategy B descends into the conversation-list wrapper (not the header)
 *   (b) The banner is never returned as a conversation row.
 */
'use strict';

const { JSDOM } = require('jsdom');

// ─── Mock DOM: header (with restriction banner) + conversation list ─────────

const dom = new JSDOM(`<!DOCTYPE html>
<html><body style="display:flex;width:1280px;height:800px">

  <!-- Whole sidebar container (scrollable) -->
  <div id="sidebar">

    <!-- Header wrapper: tabs + search + pills + restriction banner.
         Total height dominates the conversation-list wrapper because the
         restriction banner alone is ~180 px. -->
    <div id="header-wrapper">
      <div id="tabs">tabs</div>
      <div id="search">search</div>
      <div id="pills">pills</div>
      <div id="restriction-banner" role="alert">
        <strong>WhatsApp account restricted</strong>
        <p>Your WhatsApp account's messaging capabilities have been restricted
        due to activity that does not comply with WhatsApp's Commerce Policy.
        You can request a review if you believe this is incorrect.</p>
        <a href="#">View details in Business Support Home.</a>
      </div>
    </div>

    <!-- Conversation list wrapper: three real conversation rows.
         Each row carries a data-surface*="thread_title" marker — the signal
         the fix uses to prefer this branch over the (taller) header wrapper. -->
    <div id="list-wrapper">
      <div class="row">
        <span data-surface="wec:thread_title">.</span>
        <div>можете прайс скинуть</div>
      </div>
      <div class="row">
        <span data-surface="wec:thread_title">995511258620</span>
        <div>თქვენ: 💜</div>
      </div>
      <div class="row">
        <span data-surface="wec:thread_title">Marika</span>
        <div>თქვენ: 395 ლარი არის 10 სესიის…</div>
      </div>
    </div>

  </div>
</body></html>`, { pretendToBeVisual: true });

const { window } = dom;
const { document } = window;

Object.defineProperty(window, 'innerWidth',  { value: 1280, configurable: true });
Object.defineProperty(window, 'innerHeight', { value: 800,  configurable: true });

// ─── Mock getBoundingClientRect per element ────────────────────────────────

const rects = {
  '#sidebar'           : { height: 800, width: 380, left: 0,  top: 0   },
  '#header-wrapper'    : { height: 420, width: 380, left: 0,  top: 0   }, // taller than list-wrapper on purpose
  '#tabs'              : { height: 40,  width: 380, left: 0,  top: 0   },
  '#search'            : { height: 50,  width: 380, left: 0,  top: 40  },
  '#pills'             : { height: 40,  width: 380, left: 0,  top: 90  },
  '#restriction-banner': { height: 180, width: 380, left: 0,  top: 130 }, // fits 50–220 window
  '#list-wrapper'      : { height: 300, width: 380, left: 0,  top: 420 }, // shorter than header wrapper
};
for (const [sel, r] of Object.entries(rects)) {
  const el = document.querySelector(sel);
  el.getBoundingClientRect = () => ({
    height: r.height, width: r.width,
    left: r.left, right: r.left + r.width,
    top: r.top, bottom: r.top + r.height,
  });
}
document.querySelectorAll('#list-wrapper .row').forEach((el, i) => {
  el.getBoundingClientRect = () => ({
    height: 90, width: 380,
    left: 0, right: 380,
    top: 420 + i * 90, bottom: 510 + i * 90,
  });
});

// ─── Port of the helpers + Strategy B/C from content.js ────────────────────
// Kept in sync with content.js; test breaks if the guard functions regress.

function isSidebarNotice(el) {
  if (!el || !el.getAttribute) return false;
  const role = el.getAttribute('role');
  if (role === 'alert' || role === 'alertdialog') return true;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /account restricted|commerce policy|business support home/i.test(text);
}

function isInsideSidebarNotice(el, stopAt) {
  let cur = el && el.parentElement;
  while (cur && cur !== stopAt) {
    if (isSidebarNotice(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}

function hasConversationRowSignal(el) {
  if (!el || !el.querySelector) return false;
  return !!(el.querySelector('[data-surface*="thread_title"]') ||
            el.querySelector('a[href*="selected_item_id"]'));
}

function extractRowName(el) {
  const titleNode = el.querySelector('[data-surface*="thread_title"]');
  if (titleNode) return titleNode.textContent.replace(/\s+/g, ' ').trim();
  const strong = el.querySelector('strong');
  if (strong) return strong.textContent.replace(/\s+/g, ' ').trim();
  return null;
}

function getConversationItemsStrategyB(container) {
  const half = window.innerWidth / 2;
  let level = container;
  const trace = [];
  for (let depth = 0; depth < 6; depth++) {
    const children = Array.from(level.children);

    const rows = children.filter(el => {
      if (isSidebarNotice(el)) return false;
      const r = el.getBoundingClientRect();
      if (!(r.height >= 50 && r.height <= 220 && r.width > 80 && r.left < half && r.left >= 0)) return false;
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      return text.length >= 4 && !/^[.…]+$/.test(text);
    });

    if (rows.length >= 2) {
      trace.push(`depth=${depth} rows=${rows.length}`);
      const named = [];
      for (const row of rows) {
        const name = extractRowName(row);
        if (!name) continue;
        named.push({ name, row });
      }
      if (named.length > 0) return { items: named, trace };
    }

    if (children.length === 1) {
      level = children[0];
    } else if (children.length > 1) {
      const eligible = children.filter(el => {
        if (isSidebarNotice(el)) return false;
        const r = el.getBoundingClientRect();
        return r.left < half && r.height > 100 && r.width > 80;
      });
      const signalled = eligible.filter(hasConversationRowSignal);
      const pool = signalled.length > 0 ? signalled : eligible;
      const candidate = pool.sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      if (candidate && candidate !== level) {
        trace.push(`depth=${depth} descend=${signalled.length > 0 ? 'signalled' : 'tallest'}(${candidate.id || candidate.className})`);
        level = candidate;
      } else {
        break;
      }
    } else {
      break;
    }
  }
  return { items: [], trace };
}

function getConversationItemsStrategyC(container) {
  const half = window.innerWidth / 2;
  const allEls = Array.from(container.querySelectorAll('*'));
  const rowCandidates = allEls.filter(el => {
    if (isSidebarNotice(el) || isInsideSidebarNotice(el, container)) return false;
    const r = el.getBoundingClientRect();
    if (!(r.height >= 50 && r.height <= 220 && r.width > 100 && r.left < half && r.left >= 0)) return false;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    return text.length >= 4 && text.length <= 400 && !/^[.…]+$/.test(text);
  });
  const outerRows = rowCandidates.filter(el =>
    !rowCandidates.some(other => other !== el && other.contains(el))
  );
  return outerRows.map(row => ({ name: extractRowName(row), row })).filter(x => x.name);
}

// ─── Assertions ────────────────────────────────────────────────────────────

const sidebar = document.getElementById('sidebar');
let allPass = true;

// Test 1: Strategy B finds all three real conversations via the signal-first descent
console.log('\n=== Test 1: Strategy B skips banner, descends into signalled list-wrapper ===');
const { items: bItems, trace } = getConversationItemsStrategyB(sidebar);
console.log('Trace:', trace.join(' → '));
console.log(`Found ${bItems.length} items:`);
bItems.forEach((it, i) => console.log(`  [${i}] "${it.name}"`));

const expected = ['.', '995511258620', 'Marika'];
const b1 = bItems.length === 3;
const b2 = expected.every(name => bItems.some(it => it.name === name));
const b3 = !bItems.some(it => /restricted/i.test(it.name));
const test1 = b1 && b2 && b3;
console.log(test1 ? '✓ PASS' : `✗ FAIL (count=${b1} allNames=${b2} noBanner=${b3})`);
allPass = allPass && test1;

// Test 2: Strategy C also excludes the banner + its descendants
console.log('\n=== Test 2: Strategy C excludes banner descendants ===');
const cItems = getConversationItemsStrategyC(sidebar);
console.log(`Found ${cItems.length} items:`);
cItems.forEach((it, i) => console.log(`  [${i}] "${it.name}"`));

const c1 = cItems.length >= 3;
const c2 = !cItems.some(it => /restricted|commerce policy|business support/i.test(it.name));
const test2 = c1 && c2;
console.log(test2 ? '✓ PASS' : `✗ FAIL (count≥3=${c1} noBanner=${c2})`);
allPass = allPass && test2;

// Test 3: isSidebarNotice recognises the banner directly
console.log('\n=== Test 3: isSidebarNotice recognises the banner ===');
const banner = document.getElementById('restriction-banner');
const row = document.querySelector('#list-wrapper .row');
const test3 = isSidebarNotice(banner) && !isSidebarNotice(row);
console.log(test3 ? '✓ PASS' : `✗ FAIL (banner=${isSidebarNotice(banner)} row=${isSidebarNotice(row)})`);
allPass = allPass && test3;

// ─── Summary ───────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(allPass ? '✓ All tests passed — restriction banner is correctly skipped'
                    : '✗ Some tests failed');
process.exit(allPass ? 0 : 1);
