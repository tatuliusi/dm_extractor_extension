/**
 * utils.js — Shared helpers for DM Extractor
 * Loaded before content.js by the manifest.
 */

'use strict';

// ─── Sleep ────────────────────────────────────────────────────────────────────

/** Pause execution for `ms` milliseconds. */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── DOM waiting ──────────────────────────────────────────────────────────────

/**
 * Poll for a CSS selector to appear in the DOM.
 * Resolves with the element when found, rejects after `timeout` ms.
 * Uses setInterval (not rAF) so it works even when the tab is hidden.
 *
 * @param {string} selector
 * @param {number} [timeout=5000]
 * @param {Element} [root=document]
 * @returns {Promise<Element>}
 */
function waitForElement(selector, timeout = 5000, root = document) {
  return new Promise((resolve, reject) => {
    const existing = root.querySelector(selector);
    if (existing) { resolve(existing); return; }

    const deadline = Date.now() + timeout;
    const interval = setInterval(() => {
      const el = root.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error(`waitForElement timed out: ${selector}`));
      }
    }, 200);
  });
}

/**
 * Same as waitForElement but resolves with ALL matching elements (NodeList).
 * Resolves as soon as at least one element is present.
 */
function waitForElements(selector, timeout = 5000, root = document) {
  return new Promise((resolve, reject) => {
    const existing = root.querySelectorAll(selector);
    if (existing.length) { resolve(existing); return; }

    const deadline = Date.now() + timeout;
    const interval = setInterval(() => {
      const els = root.querySelectorAll(selector);
      if (els.length) {
        clearInterval(interval);
        resolve(els);
      } else if (Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error(`waitForElements timed out: ${selector}`));
      }
    }, 200);
  });
}

/**
 * Wait until the number of elements matching `selector` stops growing.
 * Polls every `interval` ms; resolves once the count has been stable for
 * `stableRounds` consecutive polls, or after `timeout` ms — whichever comes first.
 * Always waits for at least one match before starting the stability countdown.
 */
async function waitForCountStable(selector, {
  timeout      = 5000,
  interval     = 250,
  stableRounds = 3,
  root         = document,
} = {}) {
  const deadline = Date.now() + timeout;
  let lastCount  = -1;
  let stable     = 0;
  while (Date.now() < deadline) {
    const count = root.querySelectorAll(selector).length;
    if (count > 0 && count === lastCount) {
      if (++stable >= stableRounds) return;
    } else {
      stable    = 0;
      lastCount = count;
    }
    await sleep(interval);
  }
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MONTH_NAMES = {
  january:0,february:1,march:2,april:3,may:4,june:5,
  july:6,august:7,september:8,october:9,november:10,december:11,
  jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11
};
// Georgian month names used by WhatsApp/WEC date separators (e.g. "13 მაისი. 2026, 18:17")
const GEORGIAN_MONTHS = {
  'იანვარი':0,'თებერვალი':1,'მარტი':2,'აპრილი':3,
  'მაისი':4,'ივნისი':5,'ივლისი':6,'აგვისტო':7,
  'სექტემბერი':8,'ოქტომბერი':9,'ნოემბერი':10,'დეკემბერი':11,
  'იანვ':0,'თებ':1,'მარ':2,'აპრ':3,
  'მაი':4,'ივნ':5,'ივლ':6,'აგვ':7,
  'სექ':8,'ოქტ':9,'ნოე':10,'დეკ':11,
};
// Georgian weekday abbreviations/full names (JS day index: 0=Sun, 1=Mon … 6=Sat)
// WEC date dividers use short forms like "შაბ, 19:42" or "ოთხ"
const GEORGIAN_WEEKDAYS = {
  'ორშ':1,'ორშ.':1,'ორშაბათი':1,     // Monday
  'სამ':2,'სამ.':2,'სამშაბათი':2,     // Tuesday
  'ოთხ':3,'ოთხ.':3,'ოთხშაბათი':3,    // Wednesday
  'ხუთ':4,'ხუთ.':4,'ხუთშაბათი':4,    // Thursday
  'პარ':5,'პარ.':5,'პარასკევი':5,     // Friday
  'შაბ':6,'შაბ.':6,'შაბათი':6,       // Saturday
  'კვი':0,'კვი.':0,'კვირა':0,        // Sunday
};

/**
 * Parse a human-readable date label from MBS thread dividers into a Date object.
 * Returns null if unparseable (caller should include conservatively).
 *
 * Handles:
 *   "Today"           → today's date at 00:00
 *   "Yesterday"       → today − 1
 *   "Monday" … "Saturday" → most recent past occurrence of that weekday
 *   "May 3"           → May 3 of current year (or previous year if that's in future)
 *   "May 3, 2024"     → explicit year
 *   ISO 8601 strings  → native Date parse
 *
 * @param {string} label
 * @returns {Date|null}
 */
function parseDateLabel(label) {
  if (!label) return null;
  const raw = label.trim();
  const lower = raw.toLowerCase();

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Strip trailing ", HH:MM" time component before any Georgian relative-date
  // comparison. WEC labels today/yesterday/weekdays as "დღეს, 14:30" or
  // "შაბ, 19:42" — the time suffix must be removed before table lookups.
  const stripped = raw.replace(/[,\.]\s*\d{1,2}:\d{2}.*$/, '').trim();

  if (lower === 'today'     || stripped === 'დღეს') return new Date(today);

  if (lower === 'yesterday' || stripped === 'გუშინ') {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    return d;
  }

  // Named weekday: "Monday", "Tuesday", …
  const dayIndex = DAY_NAMES.indexOf(lower);
  if (dayIndex !== -1) {
    const d = new Date(today);
    const diff = (today.getDay() - dayIndex + 7) % 7 || 7; // always go back at least 1 day
    d.setDate(d.getDate() - diff);
    return d;
  }

  // Georgian weekday: "შაბ, 19:42" | "ოთხ." | "ოთხშაბათი" — use already-stripped form.
  const geoWeekIdx = GEORGIAN_WEEKDAYS[stripped];
  if (geoWeekIdx !== undefined) {
    const d = new Date(today);
    const diff = (today.getDay() - geoWeekIdx + 7) % 7 || 7;
    d.setDate(d.getDate() - diff);
    return d;
  }

  // "May 3" or "May 3, 2024"
  const monthDayYear = raw.match(
    /^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/
  );
  if (monthDayYear) {
    const monthKey = monthDayYear[1].toLowerCase();
    const monthIdx = MONTH_NAMES[monthKey];
    if (monthIdx !== undefined) {
      const day = parseInt(monthDayYear[2], 10);
      const year = monthDayYear[3]
        ? parseInt(monthDayYear[3], 10)
        : today.getFullYear();
      const d = new Date(year, monthIdx, day, 0, 0, 0, 0);
      // If month/day is in the future (no year given), assume last year
      if (!monthDayYear[3] && d > today) d.setFullYear(year - 1);
      return d;
    }
  }

  // "13 მაისი. 2026" or "13 მაისი. 2026, 18:17" — WEC/WhatsApp Georgian datetime format
  const geoMatch = raw.match(/^(\d{1,2})\s+([^\d\s.][^\d.]*?)\.?\s*,?\s*(\d{4})/);
  if (geoMatch) {
    const monthName = geoMatch[2].trim();
    const monthIdx = GEORGIAN_MONTHS[monthName] ?? MONTH_NAMES[monthName.toLowerCase()];
    if (monthIdx !== undefined) {
      return new Date(parseInt(geoMatch[3], 10), monthIdx, parseInt(geoMatch[1], 10), 0, 0, 0, 0);
    }
  }

  // "8 ივნისი" — Georgian month name without year.
  // MBS omits the year for same-calendar-year dates (e.g. conversations from
  // 8–30+ days ago in the same year). Without this branch they return null and
  // get conservatively included, breaking date-range filtering.
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

  // Last resort: native parse (handles ISO 8601 etc.)
  const native = new Date(raw);
  if (!isNaN(native.getTime())) {
    native.setHours(0, 0, 0, 0);
    return native;
  }

  return null;
}

/**
 * Return true if `date` falls within [from, to] inclusive (date-only comparison).
 * If date is null (unparseable), returns true conservatively.
 *
 * @param {Date|null} date
 * @param {Date} from
 * @param {Date} to
 */
function dateInRange(date, from, to) {
  if (!date) return true; // conservative inclusion
  const d = new Date(date); d.setHours(0,0,0,0);
  const f = new Date(from); f.setHours(0,0,0,0);
  const t = new Date(to);   t.setHours(0,0,0,0);
  return d >= f && d <= t;
}

/**
 * Get the selected_item_id URL parameter from the current page URL,
 * or from a custom URL string.
 *
 * @param {string} [url]
 * @returns {string|null}
 */
function getSelectedItemId(url) {
  try {
    const u = new URL(url || window.location.href);
    return u.searchParams.get('selected_item_id');
  } catch {
    return null;
  }
}

/**
 * Build the download subfolder name from the current page URL.
 * Format: "{platform}+{business_id}"  e.g. "instagram_direct+527561502714866"
 *
 * Platform  — the path segment immediately after /inbox/
 * Business ID — the business_id query parameter
 *
 * Falls back gracefully: only platform, only business_id, or "dm_extractor".
 */
function getContextFolder() {
  try {
    const url        = new URL(window.location.href);
    const pathMatch  = url.pathname.match(/\/inbox\/([^/?#]+)/i);
    const platform   = pathMatch ? pathMatch[1] : null;
    const businessId = url.searchParams.get('business_id');

    if (platform && businessId) return platform + '+' + businessId;
    if (platform)               return platform;
    if (businessId)             return 'dm_extractor+' + businessId;
  } catch { /* ignore malformed URL */ }
  return 'dm_extractor';
}

/**
 * Detect which inbox type is active based on URL path segment or page heading.
 * Returns one of: "WhatsApp" | "Messenger" | "Instagram" | "Unknown"
 *
 * MBS URL path patterns:
 *   /latest/inbox/wec/...                → WhatsApp Business (WEC)
 *   /latest/inbox/instagram_messaging/   → Instagram
 *   /latest/inbox/messenger/             → Messenger
 *   /latest/inbox  (no sub-path)         → Messenger (default)
 */
function detectInboxType() {
  const path = window.location.pathname.toLowerCase();
  if (path.includes('/inbox/wec'))                  return 'WhatsApp';
  if (path.includes('/inbox/instagram'))            return 'Instagram';
  if (path.includes('/inbox/messenger'))            return 'Messenger';

  const href = window.location.href.toLowerCase();
  if (href.includes('whatsapp'))                    return 'WhatsApp';
  if (href.includes('instagram'))                   return 'Instagram';

  // Try to read the active tab label from the MBS inbox switcher
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  if (activeTab) {
    const text = activeTab.textContent.trim();
    if (/whatsapp/i.test(text)) return 'WhatsApp';
    if (/instagram/i.test(text)) return 'Instagram';
    if (/messenger/i.test(text)) return 'Messenger';
  }

  // Default: anything under /latest/inbox is Messenger
  if (path.includes('/latest/inbox')) return 'Messenger';

  return 'Unknown';
}
