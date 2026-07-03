/**
 * test_folder_naming.js
 * Verifies getContextFolder / slugifyPageName / findActivePageName produce
 * per-page folder names from real MBS URLs. business_id is shared across every
 * Page in a Business Manager account, so the previous naming scheme
 * ("platform+business_id") collapsed all Pages into one folder. asset_id (or
 * page_id) is per-Page and is the correct identifier; the account switcher
 * name is preferred when we can find it.
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

// ─── Inline copies from utils.js (kept in sync manually so tests run in Node) ─

function isPlausiblePageName(s) {
  if (!s) return false;
  const t = String(s).replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 60) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (/^(inbox|messages?|home|search|settings|notifications?|meta business suite|help|create|calendar|posts?)$/i.test(t)) return false;
  return true;
}

function slugifyPageName(name) {
  const cleaned = String(name)
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 40);
  return cleaned || null;
}

function findActivePageName(doc) {
  const seen = new Set();
  const collect = [];
  const push = sel => {
    doc.querySelectorAll(sel).forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      collect.push(el);
    });
  };
  push('[data-pagelet*="AccountSwitcher"] [dir="auto"]');
  push('[data-pagelet*="AccountSwitcher"] strong');
  push('[data-pagelet*="PageSwitcher"] [dir="auto"]');
  push('[data-pagelet*="PageSwitcher"] strong');
  push('[data-testid*="account_switcher"] strong');
  push('[data-testid*="account_switcher"] span');
  push('[data-testid*="page_switcher"] strong');
  push('[data-testid*="business_switcher"] strong');
  push('[data-testid*="business_switcher"] span');
  push('[role="banner"] [role="button"][aria-label]');
  push('header [role="button"][aria-label]');
  push('header strong');
  push('[aria-label*="Business account"]');
  push('[aria-label*="Page account"]');
  push('[data-visualcompletion="ignore-dynamic"] strong');
  for (const el of collect) {
    const raw = el.getAttribute('aria-label') || el.textContent || '';
    if (isPlausiblePageName(raw)) return raw.replace(/\s+/g, ' ').trim();
  }
  const t = (doc.title || '').trim();
  if (t) {
    const segments = t.split(/\s*[|·—–-]\s*/).map(s => s.trim()).filter(Boolean);
    for (const seg of segments) {
      if (isPlausiblePageName(seg)) return seg;
    }
  }
  return null;
}

function getContextFolder(href, doc, nameOverride) {
  try {
    const url = new URL(href);
    const pathMatch = url.pathname.match(/\/inbox\/([^/?#]+)/i);
    const platform  = pathMatch ? pathMatch[1] : null;
    const assetId   = url.searchParams.get('page_id') || url.searchParams.get('asset_id');
    const overrideTrim = nameOverride ? String(nameOverride).trim() : '';
    const pageName  = overrideTrim || (doc ? findActivePageName(doc) : null);
    const pageSlug  = pageName ? slugifyPageName(pageName) : null;
    if (platform && pageSlug) return platform + '+' + pageSlug;
    if (platform && assetId)  return platform + '+' + assetId;
    if (platform)             return platform;
    if (assetId)              return 'dm_extractor+' + assetId;
  } catch { /* ignore malformed URL */ }
  return 'dm_extractor';
}

function getPageAssetId(href) {
  try {
    const url = new URL(href);
    return url.searchParams.get('page_id') || url.searchParams.get('asset_id') || null;
  } catch { return null; }
}

// ─── Real URLs supplied by the user ──────────────────────────────────────────

const URL_OBSIDIA = 'https://business.facebook.com/latest/inbox/instagram_direct?asset_id=807781679079979&business_id=527561502714866&ir_qe_exposed=1&selected_item_id=340282366841710301244259751581504505718&thread_type=IG_MESSAGE&mailbox_id=807781679079979';
const URL_LOLITA  = 'https://business.facebook.com/latest/inbox/instagram_direct?global_scope_id=527561502714866&business_id=527561502714866&page_id=471864186344525&asset_id=471864186344525&redirect_session_id=bd69ffc0-7fce-416e-b27c-8f4240bfedae';
const URL_STAMBA  = 'https://business.facebook.com/latest/inbox/instagram_direct?global_scope_id=527561502714866&business_id=527561502714866&page_id=375265913266989&asset_id=375265913266989&redirect_session_id=cb15025d-ccde-4d50-a15c-ce7ae85c65c2';

const emptyDoc = new JSDOM('<!DOCTYPE html><html><body></body></html>').window.document;

// ─── Test 1: three real URLs no longer collapse into one folder ─────────────

console.log('\n=== Test: real URLs produce distinct folders (asset_id fallback) ===');

const fObsidia = getContextFolder(URL_OBSIDIA, emptyDoc);
const fLolita  = getContextFolder(URL_LOLITA,  emptyDoc);
const fStamba  = getContextFolder(URL_STAMBA,  emptyDoc);

assert(fObsidia === 'instagram_direct+807781679079979', `obsidia → "${fObsidia}"`);
assert(fLolita  === 'instagram_direct+471864186344525', `lolita  → "${fLolita}"`);
assert(fStamba  === 'instagram_direct+375265913266989', `stamba  → "${fStamba}"`);

const distinct = new Set([fObsidia, fLolita, fStamba]);
assert(distinct.size === 3, `three URLs yield three distinct folders (got ${distinct.size})`);

// Old business_id-based logic would have collapsed all three into the same
// folder. Verify that never happens now.
assert(!/\+527561502714866$/.test(fObsidia), 'obsidia folder does NOT contain business_id');
assert(!/\+527561502714866$/.test(fLolita),  'lolita folder does NOT contain business_id');
assert(!/\+527561502714866$/.test(fStamba),  'stamba folder does NOT contain business_id');

// ─── Test 2: page name from account switcher wins over asset_id ─────────────

console.log('\n=== Test: page name from account switcher is preferred ===');

const withNameDoc = new JSDOM(`<!DOCTYPE html><html><body>
  <div data-pagelet="AccountSwitcher_top">
    <button><strong dir="auto">Obsidia</strong></button>
  </div>
</body></html>`).window.document;

assert(getContextFolder(URL_OBSIDIA, withNameDoc) === 'instagram_direct+Obsidia',
  'account-switcher name is used in folder');

// Multi-word name gets underscores, not spaces
const stambaDoc = new JSDOM(`<!DOCTYPE html><html><body>
  <div data-testid="account_switcher_toggle">
    <strong>Cafe Stamba</strong>
  </div>
</body></html>`).window.document;

assert(getContextFolder(URL_STAMBA, stambaDoc) === 'instagram_direct+Cafe_Stamba',
  '"Cafe Stamba" slugifies to "Cafe_Stamba"');

// Georgian name preserved (unicode letters)
const geoDoc = new JSDOM(`<!DOCTYPE html><html><body>
  <div data-pagelet="AccountSwitcher_x">
    <strong>ობსიდია</strong>
  </div>
</body></html>`).window.document;

assert(getContextFolder(URL_OBSIDIA, geoDoc) === 'instagram_direct+ობსიდია',
  'Georgian name preserved via \\p{L} in slugify');

// ─── Test 3: generic UI strings are rejected ────────────────────────────────

console.log('\n=== Test: generic header text is not treated as a page name ===');

const noiseDoc = new JSDOM(`<!DOCTYPE html><html><body>
  <header>
    <strong>Inbox</strong>
    <strong>Messages</strong>
    <strong>Meta Business Suite</strong>
  </header>
</body></html>`).window.document;

// Should fall back to asset_id, not use "Inbox"/"Messages"/"Meta Business Suite"
assert(getContextFolder(URL_OBSIDIA, noiseDoc) === 'instagram_direct+807781679079979',
  'generic strings ignored, asset_id used');

// ─── Test 4: slugifyPageName helper ─────────────────────────────────────────

console.log('\n=== Test: slugifyPageName ===');

assert(slugifyPageName('Obsidia') === 'Obsidia', 'simple name unchanged');
assert(slugifyPageName('Cafe Stamba') === 'Cafe_Stamba', 'spaces → underscores');
assert(slugifyPageName('  trimmed  ') === 'trimmed', 'trims whitespace');
assert(slugifyPageName('Café / Stamba!') === 'Café_Stamba', 'punctuation stripped, whitespace run collapsed to single underscore');
assert(slugifyPageName('ხინკლის სახლი') === 'ხინკლის_სახლი', 'Georgian preserved');
assert(slugifyPageName('Кафе Обсидия') === 'Кафе_Обсидия', 'Cyrillic preserved');
assert(slugifyPageName('a'.repeat(60)) === 'a'.repeat(40), 'capped at 40 chars');
assert(slugifyPageName('') === null, 'empty → null');
assert(slugifyPageName('***') === null, 'symbol-only → null');

// ─── Test 5: isPlausiblePageName ────────────────────────────────────────────

console.log('\n=== Test: isPlausiblePageName ===');

assert(isPlausiblePageName('Obsidia') === true, 'plain name ok');
assert(isPlausiblePageName('a') === false, 'too short rejected');
assert(isPlausiblePageName('x'.repeat(61)) === false, 'too long rejected');
assert(isPlausiblePageName('12345') === false, 'digits-only rejected');
assert(isPlausiblePageName('Inbox') === false, 'UI string "Inbox" rejected');
assert(isPlausiblePageName('Notifications') === false, 'UI string "Notifications" rejected');
assert(isPlausiblePageName('') === false, 'empty rejected');
assert(isPlausiblePageName(null) === false, 'null rejected');
assert(isPlausiblePageName('   ') === false, 'whitespace-only rejected');

// ─── Test 6: fallbacks when platform / assetId missing ──────────────────────

console.log('\n=== Test: graceful fallbacks ===');

assert(getContextFolder('https://business.facebook.com/other/path', emptyDoc) === 'dm_extractor',
  'no platform + no asset → "dm_extractor"');

assert(getContextFolder('https://business.facebook.com/other/path?asset_id=123', emptyDoc) === 'dm_extractor+123',
  'no platform + asset_id → "dm_extractor+123"');

assert(getContextFolder('https://business.facebook.com/latest/inbox/wec/foo', emptyDoc) === 'wec',
  'platform only → "wec"');

assert(getContextFolder('not-a-valid-url', emptyDoc) === 'dm_extractor',
  'malformed URL → "dm_extractor"');

// business_id alone (no page_id, no asset_id) is no longer used — the old
// behaviour of "platform+business_id" is intentionally dropped because
// business_id can't distinguish Pages.
assert(getContextFolder('https://business.facebook.com/latest/inbox/messenger?business_id=999', emptyDoc) === 'messenger',
  'business_id alone → falls through to platform-only (asset_id is required for per-Page folder)');

// ─── Test 7: user-typed nameOverride beats the DOM probe ────────────────────

console.log('\n=== Test: nameOverride from panel input wins ===');

// Even with a DOM name available, the user's typed value should win.
const overrideBaseDoc = new JSDOM(`<!DOCTYPE html><html><body>
  <div data-pagelet="AccountSwitcher_x"><strong>Some Auto Name</strong></div>
</body></html>`).window.document;

assert(getContextFolder(URL_OBSIDIA, overrideBaseDoc, 'Obsidia') === 'instagram_direct+Obsidia',
  'explicit override "Obsidia" wins over DOM "Some Auto Name"');

// Slugification runs on the override
assert(getContextFolder(URL_STAMBA, emptyDoc, 'Cafe Stamba') === 'instagram_direct+Cafe_Stamba',
  'override with spaces slugified');

assert(getContextFolder(URL_OBSIDIA, emptyDoc, 'ობსიდია / Obsidia!') === 'instagram_direct+ობსიდია_Obsidia',
  'override with punctuation cleaned and Georgian preserved');

// Empty/whitespace override → treated as no override, fall through to auto-detect
assert(getContextFolder(URL_OBSIDIA, overrideBaseDoc, '') === 'instagram_direct+Some_Auto_Name',
  'empty override falls back to DOM auto-detect');

assert(getContextFolder(URL_OBSIDIA, overrideBaseDoc, '   ') === 'instagram_direct+Some_Auto_Name',
  'whitespace-only override falls back to DOM auto-detect');

// No DOM auto-detect + no override → asset_id
assert(getContextFolder(URL_OBSIDIA, emptyDoc, '') === 'instagram_direct+807781679079979',
  'empty override + empty DOM → asset_id fallback');

assert(getContextFolder(URL_OBSIDIA, emptyDoc, undefined) === 'instagram_direct+807781679079979',
  'undefined override + empty DOM → asset_id fallback');

// ─── Test 8: document.title fallback ────────────────────────────────────────

console.log('\n=== Test: document.title parsing as last-resort probe ===');

const titleDom = new JSDOM(
  `<!DOCTYPE html><html><head><title>Inbox | Obsidia | Meta Business Suite</title></head><body></body></html>`
).window.document;

assert(getContextFolder(URL_OBSIDIA, titleDom) === 'instagram_direct+Obsidia',
  'page name extracted from document.title middle segment');

const titleDashDom = new JSDOM(
  `<!DOCTYPE html><html><head><title>Cafe Stamba - Meta Business Suite</title></head><body></body></html>`
).window.document;

assert(getContextFolder(URL_STAMBA, titleDashDom) === 'instagram_direct+Cafe_Stamba',
  'dash-separated title works');

// Generic title (no page name) → falls through to asset_id
const genericTitleDom = new JSDOM(
  `<!DOCTYPE html><html><head><title>Meta Business Suite</title></head><body></body></html>`
).window.document;

assert(getContextFolder(URL_OBSIDIA, genericTitleDom) === 'instagram_direct+807781679079979',
  'generic-only title → asset_id fallback');

// ─── Test 9: getPageAssetId helper ──────────────────────────────────────────

console.log('\n=== Test: getPageAssetId — used to key localStorage per-Page ===');

assert(getPageAssetId(URL_OBSIDIA) === '807781679079979', 'obsidia asset_id extracted');
assert(getPageAssetId(URL_LOLITA)  === '471864186344525', 'lolita page_id extracted');
assert(getPageAssetId(URL_STAMBA)  === '375265913266989', 'stamba page_id extracted');
assert(getPageAssetId('https://business.facebook.com/latest/inbox/messenger') === null,
  'no asset_id / page_id → null');
assert(getPageAssetId('not-a-url') === null, 'malformed URL → null');

// ─── Summary ────────────────────────────────────────────────────────────────

console.log('\n=== Summary ===');
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) {
  console.error('✗ Some tests failed');
  process.exit(1);
} else {
  console.log('✓ All tests passed');
  process.exit(0);
}
