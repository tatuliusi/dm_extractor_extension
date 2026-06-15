/**
 * test_bugfixes.js
 * Verifies the three bug fixes:
 *   Bug 1: isDangerousActionEl blocks Done/Follow-up button elements
 *   Bug 2: extractRowName / findCustomerName return correct contact names
 *   Bug 3: parseDateLabel handles Georgian weekday format; filterByDateRange returns tooOld
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

// ─── Inline utils from utils.js ───────────────────────────────────────────────
// (copy-pasted so tests run in Node without a browser environment)

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MONTH_NAMES = {
  january:0,february:1,march:2,april:3,may:4,june:5,
  july:6,august:7,september:8,october:9,november:10,december:11,
  jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11
};
const GEORGIAN_MONTHS = {
  'იანვარი':0,'თებერვალი':1,'მარტი':2,'აპრილი':3,
  'მაისი':4,'ივნისი':5,'ივლისი':6,'აგვისტო':7,
  'სექტემბერი':8,'ოქტომბერი':9,'ნოემბერი':10,'დეკემბერი':11,
  'იანვ':0,'თებ':1,'მარ':2,'აპრ':3,
  'მაი':4,'ივნ':5,'ივლ':6,'აგვ':7,
  'სექ':8,'ოქტ':9,'ნოე':10,'დეკ':11,
};
const GEORGIAN_WEEKDAYS = {
  'ორშ':1,'ორშ.':1,'ორშაბათი':1,
  'სამ':2,'სამ.':2,'სამშაბათი':2,
  'ოთხ':3,'ოთხ.':3,'ოთხშაბათი':3,
  'ხუთ':4,'ხუთ.':4,'ხუთშაბათი':4,
  'პარ':5,'პარ.':5,'პარასკევი':5,
  'შაბ':6,'შაბ.':6,'შაბათი':6,
  'კვი':0,'კვი.':0,'კვირა':0,
};

function parseDateLabel(label) {
  if (!label) return null;
  const raw = label.trim();
  const lower = raw.toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (lower === 'today' || raw === 'დღეს') return new Date(today);
  if (lower === 'yesterday' || raw === 'გუშინ') {
    const d = new Date(today); d.setDate(d.getDate() - 1); return d;
  }

  const dayIndex = DAY_NAMES.indexOf(lower);
  if (dayIndex !== -1) {
    const d = new Date(today);
    const diff = (today.getDay() - dayIndex + 7) % 7 || 7;
    d.setDate(d.getDate() - diff);
    return d;
  }

  const geoDay = raw.replace(/[,\.]\s*\d{1,2}:\d{2}.*$/, '').trim();
  const geoWeekIdx = GEORGIAN_WEEKDAYS[geoDay];
  if (geoWeekIdx !== undefined) {
    const d = new Date(today);
    const diff = (today.getDay() - geoWeekIdx + 7) % 7 || 7;
    d.setDate(d.getDate() - diff);
    return d;
  }

  const monthDayYear = raw.match(/^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/);
  if (monthDayYear) {
    const monthKey = monthDayYear[1].toLowerCase();
    const monthIdx = MONTH_NAMES[monthKey];
    if (monthIdx !== undefined) {
      const day = parseInt(monthDayYear[2], 10);
      const year = monthDayYear[3] ? parseInt(monthDayYear[3], 10) : today.getFullYear();
      const d = new Date(year, monthIdx, day, 0, 0, 0, 0);
      if (!monthDayYear[3] && d > today) d.setFullYear(year - 1);
      return d;
    }
  }

  const geoMatch = raw.match(/^(\d{1,2})\s+([^\d\s.][^\d.]*?)\.?\s*,?\s*(\d{4})/);
  if (geoMatch) {
    const monthName = geoMatch[2].trim();
    const monthIdx = GEORGIAN_MONTHS[monthName] ?? MONTH_NAMES[monthName.toLowerCase()];
    if (monthIdx !== undefined) {
      return new Date(parseInt(geoMatch[3], 10), monthIdx, parseInt(geoMatch[1], 10), 0, 0, 0, 0);
    }
  }

  const native = new Date(raw);
  if (!isNaN(native.getTime())) { native.setHours(0,0,0,0); return native; }
  return null;
}

function dateInRange(date, from, to) {
  if (!date) return true;
  const d = new Date(date); d.setHours(0,0,0,0);
  const f = new Date(from); f.setHours(0,0,0,0);
  const t = new Date(to);   t.setHours(0,0,0,0);
  return d >= f && d <= t;
}

function filterByDateRange(messages, fromDate, toDate) {
  if (!messages.length) return { filtered: false, filteredMessages: [], tooOld: false };
  let lastDate = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = parseDateLabel(messages[i].date);
    if (d) { lastDate = d; break; }
  }
  if (!lastDate || dateInRange(lastDate, fromDate, toDate)) {
    return { filtered: false, filteredMessages: messages, tooOld: false };
  }
  const tooOld = lastDate < fromDate;
  return { filtered: true, filteredMessages: [], tooOld };
}

// ─── Bug 3 Tests: parseDateLabel + filterByDateRange ─────────────────────────

console.log('\n=== Bug 3: parseDateLabel Georgian weekday format ===');

// "შაბ, 19:42" should parse as most recent Saturday
const satResult = parseDateLabel('შაბ, 19:42');
assert(satResult !== null, '"შაბ, 19:42" parses to a Date (not null)');
assert(satResult instanceof Date && satResult.getDay() === 6, '"შაბ, 19:42" parses as Saturday (day 6)');

// "ოთხ" alone → Wednesday
const wedResult = parseDateLabel('ოთხ');
assert(wedResult !== null, '"ოთხ" parses to a Date');
assert(wedResult instanceof Date && wedResult.getDay() === 3, '"ოთხ" parses as Wednesday (day 3)');

// "ოთხ." with dot → Wednesday
const wedDotResult = parseDateLabel('ოთხ.');
assert(wedDotResult !== null, '"ოთხ." parses to a Date');
assert(wedDotResult instanceof Date && wedDotResult.getDay() === 3, '"ოთხ." parses as Wednesday');

// Full Georgian weekday name
const monResult = parseDateLabel('ორშაბათი');
assert(monResult !== null, '"ორშაბათი" (full Monday name) parses to a Date');
assert(monResult instanceof Date && monResult.getDay() === 1, '"ორშაბათი" parses as Monday');

// Georgian "Today"
const todayResult = parseDateLabel('დღეს');
const todayExpected = new Date(); todayExpected.setHours(0,0,0,0);
assert(todayResult !== null, '"დღეს" (Today) parses to a Date');
assert(todayResult instanceof Date && todayResult.getTime() === todayExpected.getTime(), '"დღეს" is today');

// Georgian "Yesterday"
const yesterdayResult = parseDateLabel('გუშინ');
const yesterdayExpected = new Date(); yesterdayExpected.setHours(0,0,0,0); yesterdayExpected.setDate(yesterdayExpected.getDate() - 1);
assert(yesterdayResult !== null, '"გუშინ" (Yesterday) parses to a Date');
assert(yesterdayResult instanceof Date && yesterdayResult.getTime() === yesterdayExpected.getTime(), '"გუშინ" is yesterday');

// Existing Georgian month format still works
const geoMonthResult = parseDateLabel('13 მაისი. 2026');
assert(geoMonthResult !== null, '"13 მაისი. 2026" still parses correctly');
assert(geoMonthResult instanceof Date && geoMonthResult.getFullYear() === 2026 && geoMonthResult.getMonth() === 4 && geoMonthResult.getDate() === 13, '"13 მაისი. 2026" is 2026-05-13');

console.log('\n=== Bug 3: filterByDateRange tooOld flag ===');

const fromDate = new Date('2026-05-01T00:00:00');
const toDate   = new Date('2026-05-31T23:59:59');

// Old conversation (April) → tooOld should be true
const oldMsgs = [{ date: '13 აპრილი. 2026', text: 'hello' }];
const oldResult = filterByDateRange(oldMsgs, fromDate, toDate);
assert(oldResult.filtered === true, 'April conversation is filtered out');
assert(oldResult.tooOld === true, 'April conversation sets tooOld=true');
assert(oldResult.filteredMessages.length === 0, 'April conversation has 0 filteredMessages');

// Future conversation (June) → filtered but NOT tooOld
const futureMsgs = [{ date: '2 ივნისი. 2026', text: 'hello' }];
const futureResult = filterByDateRange(futureMsgs, fromDate, toDate);
assert(futureResult.filtered === true, 'June conversation is filtered out');
assert(futureResult.tooOld === false, 'June conversation sets tooOld=false (too new, not too old)');

// In-range conversation (May) → not filtered
const inRangeMsgs = [{ date: '15 მაისი. 2026', text: 'hello' }];
const inRangeResult = filterByDateRange(inRangeMsgs, fromDate, toDate);
assert(inRangeResult.filtered === false, 'May conversation is not filtered');
assert(inRangeResult.tooOld === false, 'May conversation has tooOld=false');
assert(inRangeResult.filteredMessages.length === 1, 'May conversation returns its messages');

// Unparseable date → conservative include, tooOld=false
const unknownMsgs = [{ date: 'Unknown date', text: 'hello' }];
const unknownResult = filterByDateRange(unknownMsgs, fromDate, toDate);
assert(unknownResult.filtered === false, 'Unknown date conversation is conservatively included');
assert(unknownResult.tooOld === false, 'Unknown date has tooOld=false');

// ─── Bug 1 Tests: isDangerousActionEl blocks grid/gridcell elements ───────────

console.log('\n=== Bug 1: isDangerousActionEl blocks Done button elements ===');

// Set up a minimal DOM that mirrors the WEC row action button structure
const dom1 = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="row-wrapper">
    <div class="text-area"><span>Nino Beridze</span></div>
    <div role="grid" class="_4a51" tabindex="-1">
      <div>
        <a role="row" href="#"><div role="gridcell" aria-label="გადატანა საქაღალდეში „მზადაა"" data-tooltip-delay="200"><div class="_18am"></div></div></a>
      </div>
      <div>
        <a role="row" href="#"><div role="gridcell" aria-label="გამოწერილად მონიშვნა"><div></div></div></a>
      </div>
    </div>
  </div>
</body></html>`);

const doc1 = dom1.window.document;

// Inline isDangerousActionEl from content.js
function isDangerousActionEl(el) {
  const label = (el.getAttribute('aria-label') || '').toLowerCase();
  const title = (el.getAttribute('title') || '').toLowerCase();
  const combined = label + ' ' + title;
  if (/done|მზადაა|გადატანა|delete|spam|სპამი|star|flag|archive|mark as/i.test(combined)) return true;
  if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
    const text = (el.textContent || '').trim();
    if (text.length < 40 && /done|მზადაა|delete|spam|სპამი|star|flag/i.test(text)) return true;
  }
  try {
    if (el.closest('[role="grid"],[role="gridcell"]')) return true;
    if (el.closest('._4a51')) return true;
  } catch { }
  return false;
}

// The Done gridcell div itself
const doneGridcell = doc1.querySelector('[aria-label*="მზადაა"]');
assert(doneGridcell !== null, 'Done gridcell element found in DOM');
assert(isDangerousActionEl(doneGridcell) === true, 'Done gridcell aria-label blocked');

// The anchor wrapper (a[role="row"]) — previously NOT caught, now caught via grid ancestor
const doneAnchor = doc1.querySelector('[role="grid"] a[role="row"]');
assert(doneAnchor !== null, 'Done button anchor wrapper found in DOM');
assert(isDangerousActionEl(doneAnchor) === true, 'Done button anchor (no aria-label) blocked via [role="grid"] ancestor');

// The grid container itself
const grid = doc1.querySelector('[role="grid"]');
assert(isDangerousActionEl(grid) === true, 'The grid container itself is blocked');

// The _18am inner div (deepest child of Done button)
const innerDiv = doc1.querySelector('._18am');
assert(innerDiv !== null, 'Inner div of Done button found');
assert(isDangerousActionEl(innerDiv) === true, 'Inner div of Done button blocked via grid ancestor');

// Follow-up gridcell
const followUpGridcell = doc1.querySelector('[aria-label="გამოწერილად მონიშვნა"]');
assert(isDangerousActionEl(followUpGridcell) === true, 'Follow-up gridcell blocked via role="gridcell"');

// The safe text area span should NOT be blocked
const textSpan = doc1.querySelector('.text-area span');
assert(isDangerousActionEl(textSpan) === false, 'Normal text span is NOT blocked');

// The row wrapper itself should NOT be blocked
const rowWrapper = doc1.querySelector('.row-wrapper');
assert(isDangerousActionEl(rowWrapper) === false, 'Row wrapper div is NOT blocked');

// ─── Bug 2 Tests: extractRowName and findCustomerName ────────────────────────

console.log('\n=== Bug 2: extractRowName finds name via data-surface*="thread_title" ===');

const dom2 = new JSDOM(`<!DOCTYPE html><html><body>
  <!-- WEC sidebar row with thread_title data-surface (matches real page HTML) -->
  <div class="conversation-row" style="height:94px;width:360px;">
    <div class="_4ik4 _4ik5" style="line-height:18px;height:18px;">
      <div>
        <span data-surface-wrapper="1"
              data-surface="/bizweb:inbox/bizweb:INBOX/lib:bizweb_inbox:main_content/lib:bizweb_inbox:content_layout/lib:inbox:thread_and_detail/bizweb_inbox:thread_list/thread_row0/lib:thread_title"
              style="display:contents;">
          <div class="x1vvvo52 x1fvot60 x12nagc">Карим</div>
        </span>
      </div>
    </div>
    <div class="_4ik4 _4ik5" style="line-height:18px;height:18px;">
      <div>თქვენ გაგზავნეთ დანართი.</div>
    </div>
    <!-- action buttons grid — must NOT be read as the name -->
    <div role="grid" class="_4a51">
      <a role="row" href="#"><div role="gridcell" aria-label="გადატანა საქაღალდეში „მზადაა""></div></a>
    </div>
  </div>

  <!-- WEC sidebar row with Georgian name (no Latin chars) -->
  <div class="geo-row" style="height:94px;width:360px;">
    <div>
      <span data-surface-wrapper="1"
            data-surface="/bizweb:inbox/bizweb:INBOX/.../thread_row1/lib:thread_title"
            style="display:contents;">
        <div>ნინო ბერიძე</div>
      </span>
    </div>
    <div>last message preview text</div>
  </div>

  <!-- Detail view header with display name -->
  <div data-pagelet="BizInboxDetailViewHeaderSectionWrapper">
    <div class="_3bwv">
      <div class="_3bwy">
        <div class="_3bwx">
          <div class="xn9d7h7">
            <div class="_4ik4 _4ik5" style="-webkit-line-clamp:1;">Карим</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`);

const doc2 = dom2.window.document;

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
  for (const sel of ['[role="heading"]', 'strong', 'b', 'span[dir="auto"]']) {
    const found = el.querySelector(sel);
    if (found) { const t = cleanText(found); if (t) return t; }
  }
  const label = el.getAttribute('aria-label');
  if (label) return label.split(',')[0].trim() || label.trim();
  const title = el.getAttribute('title');
  if (title) return title.trim();
  const text = cleanText(el);
  const latinPrefix = text.match(/^([A-Za-z0-9 +\-_.@]{1,60})(?=[ა-ჿ]|$)/);
  if (latinPrefix && latinPrefix[1].trim()) return latinPrefix[1].trim();
  return null;
}

// Cyrillic name (Карим) via data-surface thread_title
const convRow = doc2.querySelector('.conversation-row');
const cyrillicName = extractRowName(convRow);
assert(cyrillicName === 'Карим', `Cyrillic name extracted correctly: got "${cyrillicName}"`);

// Georgian name (ნინო ბერიძე) via data-surface thread_title
const geoRow = doc2.querySelector('.geo-row');
const georgianName = extractRowName(geoRow);
assert(georgianName === 'ნინო ბერიძე', `Georgian name extracted correctly: got "${georgianName}"`);

console.log('\n=== Bug 2: findCustomerName uses detail view header ===');

function findCustomerName(document) {
  const detailHeader = document.querySelector('[data-pagelet="BizInboxDetailViewHeaderSectionWrapper"]');
  if (detailHeader) {
    const nameEl = detailHeader.querySelector('._4ik4._4ik5');
    if (nameEl) { const t = cleanText(nameEl); if (t) return t; }
  }
  const detailSurface = document.querySelector('[data-surface*="detail_view_header"] ._4ik4._4ik5');
  if (detailSurface) { const t = cleanText(detailSurface); if (t) return t; }
  // (remaining selectors not tested here)
  return null;
}

const headerName = findCustomerName(doc2);
assert(headerName === 'Карим', `findCustomerName from detail header: got "${headerName}"`);

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
