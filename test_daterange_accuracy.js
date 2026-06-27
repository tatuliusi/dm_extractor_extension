/**
 * test_daterange_accuracy.js
 *
 * End-to-end verification that the date-range pipeline is correct:
 *   1. localDateStr() returns the LOCAL calendar date (not UTC)
 *   2. parseDateLabel() + dateInRange() correctly includes/excludes at boundaries
 *   3. filterByDateRange() + hasEvidence flag drive correct include/skip/tooOld signals
 *   4. Crawl simulation verifies consecutiveTooOld early-stop never fires inside the range
 *   5. JSON metadata (filter_from / filter_to) uses local dates, not UTC
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

// ─── Replicate production helpers from utils.js / content.js ─────────────────

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
  'სამ':2,'სამ.':2,'სამშ':2,'სამშ.':2,'სამშაბათი':2,
  'ოთხ':3,'ოთხ.':3,'ოთხშაბათი':3,
  'ხუთ':4,'ხუთ.':4,'ხუთშაბათი':4,
  'პარ':5,'პარ.':5,'პარასკევი':5,
  'შაბ':6,'შაბ.':6,'შაბათი':6,
  'კვი':0,'კვი.':0,'კვირა':0,
};

function parseDateLabel(label, _today) {
  if (!label) return null;
  const raw = label.trim();
  const lower = raw.toLowerCase();
  const today = _today || new Date(); today.setHours(0, 0, 0, 0);

  if (/^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?$/.test(raw)) return new Date(today);
  const stripped = raw.replace(/[,\.]\s*\d{1,2}:\d{2}.*$/, '').trim();
  if (lower === 'today'     || stripped === 'დღეს') return new Date(today);
  if (lower === 'yesterday' || stripped === 'გუშინ') {
    const d = new Date(today); d.setDate(d.getDate() - 1); return d;
  }
  const dayIndex = DAY_NAMES.indexOf(lower);
  if (dayIndex !== -1) {
    const d = new Date(today);
    const diff = (today.getDay() - dayIndex + 7) % 7 || 7;
    d.setDate(d.getDate() - diff); return d;
  }
  const geoWeekIdx = GEORGIAN_WEEKDAYS[stripped];
  if (geoWeekIdx !== undefined) {
    const d = new Date(today);
    const diff = (today.getDay() - geoWeekIdx + 7) % 7 || 7;
    d.setDate(d.getDate() - diff); return d;
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
    if (monthIdx !== undefined)
      return new Date(parseInt(geoMatch[3], 10), monthIdx, parseInt(geoMatch[1], 10), 0, 0, 0, 0);
  }
  const geoNoYear = raw.match(/^(\d{1,2})\s+([^\d\s,.][^\d,.]*?)\.?\s*$/);
  if (geoNoYear) {
    const monthName = geoNoYear[2].trim();
    const monthIdx = GEORGIAN_MONTHS[monthName] ?? MONTH_NAMES[monthName.toLowerCase()];
    if (monthIdx !== undefined) {
      const day = parseInt(geoNoYear[1], 10);
      const d = new Date(today.getFullYear(), monthIdx, day, 0, 0, 0, 0);
      if (d > today) d.setFullYear(today.getFullYear() - 1);
      return d;
    }
  }
  const native = new Date(raw);
  if (!isNaN(native.getTime())) { native.setHours(0, 0, 0, 0); return native; }
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
  if (!messages.length) return { filtered: false, filteredMessages: [], tooOld: false, hasEvidence: false };
  let lastDate = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = parseDateLabel(messages[i].date);
    if (d) { lastDate = d; break; }
  }
  if (!lastDate) return { filtered: false, filteredMessages: messages, tooOld: false, hasEvidence: false };
  if (dateInRange(lastDate, fromDate, toDate))
    return { filtered: false, filteredMessages: messages, tooOld: false, hasEvidence: true };
  const tooOld = lastDate < fromDate;
  return { filtered: true, filteredMessages: [], tooOld, hasEvidence: true };
}

// localDateStr — matches content.js implementation
function localDateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// ─── 1. localDateStr: timezone safety ────────────────────────────────────────

console.log('\n=== 1. localDateStr produces local calendar date, not UTC ===');

// The machine is in UTC+4. A Date created at local midnight would be UTC-4h,
// so toISOString() would return the PREVIOUS calendar day. localDateStr must return today.
const midnight = new Date(2026, 5, 15, 0, 0, 0, 0); // June 15 local midnight
const utcStr   = midnight.toISOString().slice(0, 10); // would be "2026-06-14" in UTC+4
const localStr = localDateStr(midnight);
assert(localStr === '2026-06-15', `localDateStr(June 15 local midnight) = "2026-06-15", got "${localStr}"`);
// Prove the bug existed: UTC string would be different for UTC+4
const offset = midnight.getTimezoneOffset(); // negative for UTC+
if (offset < 0) {
  // UTC+N timezone: toISOString gives previous day at midnight
  assert(utcStr !== '2026-06-15', `toISOString gives wrong date in UTC+ timezone (got "${utcStr}") — old bug confirmed`);
  console.log(`  (timezone offset: UTC${offset >= 0 ? '-' : '+'}${Math.abs(offset/60)}, demonstrating timezone correction)`);
} else {
  console.log('  (running in UTC/UTC-: timezone difference not demonstrable here, but localDateStr is still correct)');
}

// End-of-month case: June 1 local midnight in UTC+4 = May 31 UTC
const june1 = new Date(2026, 5, 1, 0, 0, 0, 0);
assert(localDateStr(june1) === '2026-06-01', `localDateStr(June 1 local midnight) = "2026-06-01"`);

// ─── 2. parseDateLabel boundary dates ────────────────────────────────────────

console.log('\n=== 2. parseDateLabel: exact boundary dates ===');

// Fixed reference point so tests are deterministic: use June 27, 2026 (Saturday)
const TODAY = new Date(2026, 5, 27, 0, 0, 0, 0);

function fmt(d) {
  if (!d) return 'null';
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

assert(fmt(parseDateLabel('June 15', TODAY)) === '2026-06-15', 'English "June 15" parses to 2026-06-15');
assert(fmt(parseDateLabel('June 20', TODAY)) === '2026-06-20', 'English "June 20" parses to 2026-06-20');
assert(fmt(parseDateLabel('Jun 15',  TODAY)) === '2026-06-15', 'Abbreviated "Jun 15" parses to 2026-06-15');
assert(fmt(parseDateLabel('15 ივნისი', TODAY)) === '2026-06-15', 'Georgian "15 ივნისი" parses to 2026-06-15');
assert(fmt(parseDateLabel('20 ივნისი', TODAY)) === '2026-06-20', 'Georgian "20 ივნისი" parses to 2026-06-20');
assert(fmt(parseDateLabel('15 ივნისი. 2026', TODAY)) === '2026-06-15', 'Georgian "15 ივნისი. 2026" parses to 2026-06-15');
assert(fmt(parseDateLabel('14:30', TODAY)) === '2026-06-27', 'Time-only "14:30" parses to today (June 27)');
assert(fmt(parseDateLabel('Today', TODAY)) === '2026-06-27', '"Today" parses to June 27');
assert(fmt(parseDateLabel('Yesterday', TODAY)) === '2026-06-26', '"Yesterday" parses to June 26');
assert(fmt(parseDateLabel('სამშ.', TODAY)) === '2026-06-23', 'Georgian Tuesday "სამშ." parses to June 23');

// ─── 3. dateInRange: inclusive boundaries ────────────────────────────────────

console.log('\n=== 3. dateInRange: exact start/end date boundaries are inclusive ===');

const from = new Date('2026-06-15T00:00:00'); // local midnight
const to   = new Date('2026-06-20T23:59:59'); // local end-of-day

// Exact boundary dates must be INCLUDED
assert(dateInRange(new Date(2026,5,15), from, to) === true,  'June 15 (exact fromDate) is IN range');
assert(dateInRange(new Date(2026,5,20), from, to) === true,  'June 20 (exact toDate) is IN range');
// Dates just outside must be EXCLUDED
assert(dateInRange(new Date(2026,5,14), from, to) === false, 'June 14 (day before from) is OUT of range');
assert(dateInRange(new Date(2026,5,21), from, to) === false, 'June 21 (day after to) is OUT of range');
// Middle dates
assert(dateInRange(new Date(2026,5,17), from, to) === true,  'June 17 (middle) is IN range');
// Null date: conservative include
assert(dateInRange(null, from, to) === true, 'null date is conservatively IN range');

// Single-day range (from === to)
const singleFrom = new Date('2026-06-18T00:00:00');
const singleTo   = new Date('2026-06-18T23:59:59');
assert(dateInRange(new Date(2026,5,18), singleFrom, singleTo) === true,  'Single-day range: June 18 is in range');
assert(dateInRange(new Date(2026,5,17), singleFrom, singleTo) === false, 'Single-day range: June 17 is out of range');
assert(dateInRange(new Date(2026,5,19), singleFrom, singleTo) === false, 'Single-day range: June 19 is out of range');

// ─── 4. filterByDateRange: full pipeline ─────────────────────────────────────

console.log('\n=== 4. filterByDateRange: in-range / too-old / too-new / no-evidence ===');

function msgs(dateLabel) {
  return [{ date: dateLabel, direction: 'inbound', text: 'hello' }];
}

// In range: June 18 (English)
const r1 = filterByDateRange(msgs('June 18'), from, to);
assert(r1.filteredMessages.length === 1, 'June 18 (English) → 1 message returned');
assert(r1.hasEvidence === true,          'June 18 (English) → hasEvidence=true');
assert(r1.tooOld === false,              'June 18 (English) → tooOld=false');

// In range: June 18 (Georgian no-year)
const r2 = filterByDateRange(msgs('18 ივნისი'), from, to);
assert(r2.filteredMessages.length === 1, 'Georgian "18 ივნისი" → 1 message returned');
assert(r2.hasEvidence === true,          'Georgian "18 ივნისი" → hasEvidence=true');

// In range: June 18 (Georgian with year)
const r3 = filterByDateRange(msgs('18 ივნისი. 2026'), from, to);
assert(r3.filteredMessages.length === 1, 'Georgian "18 ივნისი. 2026" → 1 message returned');

// Exact from boundary: June 15
const r4 = filterByDateRange(msgs('June 15'), from, to);
assert(r4.filteredMessages.length === 1, 'June 15 (exact from) → included');
assert(r4.tooOld === false,              'June 15 → tooOld=false');

// Exact to boundary: June 20
const r5 = filterByDateRange(msgs('June 20'), from, to);
assert(r5.filteredMessages.length === 1, 'June 20 (exact to) → included');
assert(r5.tooOld === false,              'June 20 → tooOld=false');

// Too old: June 14
const r6 = filterByDateRange(msgs('June 14'), from, to);
assert(r6.filteredMessages.length === 0, 'June 14 (before from) → 0 messages');
assert(r6.tooOld === true,               'June 14 → tooOld=true');
assert(r6.hasEvidence === true,          'June 14 → hasEvidence=true');

// Too new: June 21
const r7 = filterByDateRange(msgs('June 21'), from, to);
assert(r7.filteredMessages.length === 0, 'June 21 (after to) → 0 messages');
assert(r7.tooOld === false,              'June 21 → tooOld=false (too new, not too old)');
assert(r7.hasEvidence === true,          'June 21 → hasEvidence=true');

// No parseable dates → conservative include, hasEvidence=false
const r8 = filterByDateRange([{ date: null, text: 'media' }], from, to);
assert(r8.filteredMessages.length === 1, 'null date → conservative include');
assert(r8.hasEvidence === false,         'null date → hasEvidence=false (no evidence)');
assert(r8.tooOld === false,              'null date → tooOld=false');

// Empty messages
const r9 = filterByDateRange([], from, to);
assert(r9.filteredMessages.length === 0, 'Empty messages array → 0 messages');
assert(r9.hasEvidence === false,         'Empty messages → hasEvidence=false');

// ─── 5. JSON metadata localDateStr matches filter dates ───────────────────────

console.log('\n=== 5. JSON metadata: filter_from / filter_to use local dates ===');

// Simulate what startCrawler does when user enters "2026-06-15" → "2026-06-20"
const fromDate = new Date('2026-06-15T00:00:00'); // local midnight
const toDate   = new Date('2026-06-20T23:59:59'); // local end-of-day

const metaFrom = localDateStr(fromDate);
const metaTo   = localDateStr(toDate);
assert(metaFrom === '2026-06-15', `filter_from in JSON = "2026-06-15" (got "${metaFrom}")`);
assert(metaTo   === '2026-06-20', `filter_to   in JSON = "2026-06-20" (got "${metaTo}")`);

// The old bug: toISOString() would give UTC dates
// For UTC+4, fromDate local midnight = UTC June 14 20:00
const oldFrom    = fromDate.toISOString().slice(0, 10);
const oldTo      = toDate.toISOString().slice(0, 10);
const tzOffset   = fromDate.getTimezoneOffset();
if (tzOffset < 0) {
  assert(oldFrom !== '2026-06-15', `OLD toISOString gives wrong filter_from "${oldFrom}" in UTC+${Math.abs(tzOffset/60)}`);
  assert(oldTo   === '2026-06-20', `OLD toISOString for toDate (23:59:59 still same day in UTC+4): "${oldTo}"`);
}

// ─── 6. Crawl simulation: consecutiveTooOld stops correctly ──────────────────

console.log('\n=== 6. Crawl simulation: early-stop fires only after in-range window ===');

// Simulate an inbox sorted newest-first with a mix of dates.
// Range: June 15–20. Expected: download June 15–20 convs, stop after ≥4 consecutive too-old.
const inboxConversations = [
  { name: 'A', rowDateStr: 'June 27' },  // too new
  { name: 'B', rowDateStr: 'June 26' },  // too new
  { name: 'C', rowDateStr: 'June 20' },  // in range (to boundary)
  { name: 'D', rowDateStr: 'June 18' },  // in range
  { name: 'E', rowDateStr: 'June 15' },  // in range (from boundary)
  { name: 'F', rowDateStr: 'June 14' },  // too old
  { name: 'G', rowDateStr: 'June 13' },  // too old
  { name: 'H', rowDateStr: 'June 12' },  // too old
  { name: 'I', rowDateStr: 'June 11' },  // too old → should stop here
  { name: 'J', rowDateStr: 'June 10' },  // should NOT be reached
];

const MAX_CONSECUTIVE_TOO_OLD = 4;
let consecutiveTooOld = 0;
let seenTooNew = false;
let downloaded = 0;
let stopped = false;
const downloadedNames = [];
const skippedNames    = [];
let stoppedAt         = null;

for (const conv of inboxConversations) {
  const rowDate = parseDateLabel(conv.rowDateStr, new Date(2026, 5, 27));
  const inRange = rowDate && dateInRange(rowDate, from, to);
  const tooOld  = rowDate && rowDate < from;

  if (rowDate && !inRange) {
    skippedNames.push(conv.name);
    if (tooOld) {
      consecutiveTooOld++;
      if (consecutiveTooOld >= MAX_CONSECUTIVE_TOO_OLD && (seenTooNew || downloaded > 0)) {
        stoppedAt = conv.name;
        stopped = true;
        break;
      }
    } else {
      seenTooNew = true;
      consecutiveTooOld = 0;
    }
    continue;
  }

  // In range (or null date → conservative): simulate download
  downloadedNames.push(conv.name);
  downloaded++;
  consecutiveTooOld = 0;
}

assert(downloadedNames.includes('C'), 'June 20 (to boundary) was downloaded');
assert(downloadedNames.includes('D'), 'June 18 (middle) was downloaded');
assert(downloadedNames.includes('E'), 'June 15 (from boundary) was downloaded');
assert(!downloadedNames.includes('A'), 'June 27 (too new) was NOT downloaded');
assert(!downloadedNames.includes('B'), 'June 26 (too new) was NOT downloaded');
assert(!downloadedNames.includes('J'), 'June 10 was NOT reached (stopped early)');
assert(stopped === true, 'Crawler stopped early after 4 consecutive too-old conversations');
assert(stoppedAt === 'I', `Crawler stopped at conversation I (June 11), got "${stoppedAt}"`);
assert(downloaded === 3, `Downloaded exactly 3 conversations (C, D, E), got ${downloaded}`);

// ─── 7. Crawl simulation: early-stop guard prevents premature stop ───────────

console.log('\n=== 7. Crawl simulation: early-stop guard prevents stop before range is reached ===');

// If the inbox starts with 4 old conversations before reaching the target range,
// we must NOT stop early (seenTooNew=false AND downloaded=0 → guard prevents it).
const inboxWithOldPins = [
  { name: 'PIN1', rowDateStr: 'June 1' },   // too old (pinned old conv)
  { name: 'PIN2', rowDateStr: 'May 28' },   // too old
  { name: 'PIN3', rowDateStr: 'May 15' },   // too old
  { name: 'PIN4', rowDateStr: 'Apr 10' },   // too old
  { name: 'IN1',  rowDateStr: 'June 17' },  // IN RANGE ← must not be missed
  { name: 'OLD1', rowDateStr: 'June 14' },  // too old
  { name: 'OLD2', rowDateStr: 'June 13' },  // too old
  { name: 'OLD3', rowDateStr: 'June 12' },  // too old
  { name: 'OLD4', rowDateStr: 'June 11' },  // too old → stop after IN1 was already downloaded
];

let cTO2 = 0, seenNew2 = false, dl2 = 0, stopped2 = false;
const dl2Names = [];

for (const conv of inboxWithOldPins) {
  const rowDate = parseDateLabel(conv.rowDateStr, new Date(2026, 5, 27));
  const inRange = rowDate && dateInRange(rowDate, from, to);
  const tooOld  = rowDate && rowDate < from;

  if (rowDate && !inRange) {
    if (tooOld) {
      cTO2++;
      if (cTO2 >= MAX_CONSECUTIVE_TOO_OLD && (seenNew2 || dl2 > 0)) {
        stopped2 = true;
        break;
      }
    } else {
      seenNew2 = true;
      cTO2 = 0;
    }
    continue;
  }
  dl2Names.push(conv.name);
  dl2++;
  cTO2 = 0;
}

assert(dl2Names.includes('IN1'),   'IN1 (June 17) was downloaded despite 4 old pinned convs before it');
assert(!dl2Names.includes('PIN1'), 'PIN1 (old pin) was NOT downloaded');
assert(stopped2 === true,          'Crawler eventually stopped after in-range window');
assert(dl2 === 1,                  `Exactly 1 conversation downloaded, got ${dl2}`);

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
