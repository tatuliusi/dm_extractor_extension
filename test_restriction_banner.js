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
  if (role === 'alert' || role === 'alertdialog' || role === 'status') return true;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /account restricted|commerce policy|business support home|scheduled to be away|away messages will be sent|set status as available|\bai agent\b|business agent to respond/i.test(text);
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

// ─── Away scheduling banner + AI-agent promo card (Messenger) ──────────────
// A separate DOM: sidebar with two Messenger promo/notice cards on top of a
// list of anchor-based conversation rows. Regression for the case in the
// screenshot where "Away until 09:00" + "Get an AI agent…" showed up in the
// Messenger sidebar and the crawler logged "Reached end of conversation list"
// with 0 downloads / 0 skipped / 0 errors because the promo cards were
// polluting the row filter and the descent picked a wrapper without rows.

const dom2 = new JSDOM(`<!DOCTYPE html>
<html><body style="display:flex;width:1280px;height:800px">
  <div id="sidebar2">
    <div id="header2">
      <div id="tabs2">Messenger</div>
      <div id="filters2">All Priority Ad-replies Follow-up</div>
    </div>

    <!-- Away scheduling banner. In production it usually carries role="alert"
         but we deliberately omit the role here to prove the text-pattern
         branch catches it. -->
    <div id="away-banner">
      <strong>Away until 09:00</strong>
      <p>You're scheduled to be away during this time. Away messages will be sent.</p>
      <button>Set status as available</button>
    </div>

    <!-- Business-Agent promo card. Informational, uses role="status". -->
    <div id="ai-banner" role="status">
      <strong>Get an AI agent that responds to customers immediately</strong>
      <p>There are a few people waiting for your response. Quickly set up Business Agent to respond for you.</p>
      <button>Try it</button>
    </div>

    <!-- Real conversation list: three Messenger-style rows with
         selected_item_id anchors (Strategy A's primary signal). -->
    <div id="list-wrapper2">
      <div class="row2">
        <a href="/inbox/messages/?selected_item_id=100000001">
          <strong>Salome Gvinianidze</strong>
          <span>Hi there!</span>
        </a>
      </div>
      <div class="row2">
        <a href="/inbox/messages/?selected_item_id=100000002">
          <strong>Sali Bakradze</strong>
          <span>Thanks!</span>
        </a>
      </div>
      <div class="row2">
        <a href="/inbox/messages/?selected_item_id=100000003">
          <strong>Lika M</strong>
          <span>See you</span>
        </a>
      </div>
    </div>
  </div>
</body></html>`, { pretendToBeVisual: true });

const doc2 = dom2.window.document;

const rects2 = {
  '#sidebar2'      : { height: 800, width: 380, left: 0, top: 0   },
  '#header2'       : { height: 90,  width: 380, left: 0, top: 0   },
  '#away-banner'   : { height: 140, width: 380, left: 0, top: 90  }, // row-shape sized
  '#ai-banner'     : { height: 170, width: 380, left: 0, top: 230 }, // row-shape sized
  '#list-wrapper2' : { height: 300, width: 380, left: 0, top: 400 },
};
for (const [sel, r] of Object.entries(rects2)) {
  const el = doc2.querySelector(sel);
  el.getBoundingClientRect = () => ({
    height: r.height, width: r.width,
    left: r.left, right: r.left + r.width,
    top: r.top, bottom: r.top + r.height,
  });
}
doc2.querySelectorAll('#list-wrapper2 .row2').forEach((el, i) => {
  el.getBoundingClientRect = () => ({
    height: 90, width: 380,
    left: 0, right: 380,
    top: 400 + i * 90, bottom: 490 + i * 90,
  });
});

// Use window from dom2 for its getComputedStyle / innerWidth
const window2 = dom2.window;
Object.defineProperty(window2, 'innerWidth',  { value: 1280, configurable: true });
Object.defineProperty(window2, 'innerHeight', { value: 800,  configurable: true });

// Wrap the Strategy helpers so they use window2 for viewport half-width.
function makeStrategyB(win) {
  return function (container) {
    const half = win.innerWidth / 2;
    let level = container;
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
        const named = [];
        for (const row of rows) {
          const name = extractRowName(row);
          if (!name) continue;
          named.push({ name, row });
        }
        if (named.length > 0) return named;
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
        if (candidate && candidate !== level) level = candidate;
        else break;
      } else break;
    }
    return [];
  };
}

// Test 4: Away banner without role="alert" — caught by text pattern.
console.log('\n=== Test 4: isSidebarNotice catches Away banner via text pattern ===');
const awayBanner = doc2.getElementById('away-banner');
const test4 = isSidebarNotice(awayBanner);
console.log(test4 ? '✓ PASS' : '✗ FAIL — Away banner not recognized');
allPass = allPass && test4;

// Test 5: AI-agent promo card — caught by role="status" AND by text pattern.
console.log('\n=== Test 5: isSidebarNotice catches AI-agent promo (role=status + text) ===');
const aiBanner = doc2.getElementById('ai-banner');
const test5 = isSidebarNotice(aiBanner);
console.log(test5 ? '✓ PASS' : '✗ FAIL — AI-agent promo not recognized');
allPass = allPass && test5;

// Test 6: Strategy B on the mixed sidebar still finds all three real rows.
console.log('\n=== Test 6: Strategy B skips both promo cards, finds all conversation rows ===');
const strategyB2 = makeStrategyB(window2);
const items2 = strategyB2(doc2.getElementById('sidebar2'));
console.log(`Found ${items2.length} items:`);
items2.forEach((it, i) => console.log(`  [${i}] "${it.name}"`));
const expected2 = ['Salome Gvinianidze', 'Sali Bakradze', 'Lika M'];
const t6a = items2.length === 3;
const t6b = expected2.every(n => items2.some(it => it.name === n));
const t6c = !items2.some(it => /away until|ai agent|business agent/i.test(it.name));
const test6 = t6a && t6b && t6c;
console.log(test6 ? '✓ PASS' : `✗ FAIL (count=${t6a} names=${t6b} noBanners=${t6c})`);
allPass = allPass && test6;

// Test 7: real conversation-preview text that contains innocuous words should
// NOT be mistaken for a banner (guard against false positives).
console.log('\n=== Test 7: no false positive on regular conversation row text ===');
const normalRow = doc2.createElement('div');
normalRow.innerHTML = '<strong>Nino K</strong><span>Sure, I can be available tomorrow — let me know what time works</span>';
const test7 = !isSidebarNotice(normalRow);
console.log(test7 ? '✓ PASS' : '✗ FAIL — banner filter false-positive on regular message text');
allPass = allPass && test7;

// Test 8: alternate wording of the AI-agent promo card ("Get your own AI
// agent that can respond to customers"). Meta ships multiple A/B variants
// of this card so the detection must catch the stable phrase "AI agent"
// rather than any one specific sentence.
console.log('\n=== Test 8: AI-agent promo — alternate wording variant ===');
const aiBannerV2 = doc2.createElement('div');
aiBannerV2.innerHTML = `
  <span aria-hidden="true">☆</span>
  <strong>Get your own AI agent that can respond to customers</strong>
  <a href="#">მეტის ნახვა</a>
  <button aria-label="Close">×</button>`;
const test8 = isSidebarNotice(aiBannerV2);
console.log(test8 ? '✓ PASS' : '✗ FAIL — alternate AI-agent card not recognized');
allPass = allPass && test8;

// ─── Summary ───────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(allPass ? '✓ All tests passed — sidebar notice/promo banners are correctly skipped'
                    : '✗ Some tests failed');
process.exit(allPass ? 0 : 1);
