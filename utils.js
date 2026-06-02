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

// ─── Date parsing ─────────────────────────────────────────────────────────────

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
const MONTH_NAMES = {
  january:0,february:1,march:2,april:3,may:4,june:5,
  july:6,august:7,september:8,october:9,november:10,december:11,
  jan:0,feb:1,mar:2,apr:3,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11
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

  if (lower === 'today') return new Date(today);

  if (lower === 'yesterday') {
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
 * Detect which inbox type is active based on URL or page heading.
 * Returns one of: "WhatsApp" | "Messenger" | "Instagram" | "Unknown"
 */
function detectInboxType() {
  const href = window.location.href.toLowerCase();
  if (href.includes('whatsapp')) return 'WhatsApp';
  if (href.includes('instagram')) return 'Instagram';
  if (href.includes('messenger') || href.includes('latest/inbox')) return 'Messenger';

  // Try to read the active tab label from the MBS inbox switcher
  const activeTab = document.querySelector('[role="tab"][aria-selected="true"]');
  if (activeTab) {
    const text = activeTab.textContent.trim();
    if (/whatsapp/i.test(text)) return 'WhatsApp';
    if (/instagram/i.test(text)) return 'Instagram';
    if (/messenger/i.test(text)) return 'Messenger';
  }

  return 'Unknown';
}
