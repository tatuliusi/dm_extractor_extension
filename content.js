/**
 * content.js — DM Extractor for Meta Business Suite
 *
 * Entry point injected by the manifest. Responsibilities:
 *   1. Inject the floating panel into a Shadow DOM root
 *   2. Expose window.__dmExtractor bridge for panel.js and DevTools
 *   3. Run the async crawler state machine
 *   4. House all extraction logic (ported from Obsidia)
 *
 * utils.js is loaded before this file and provides:
 *   sleep(), waitForElement(), waitForElements(),
 *   parseDateLabel(), dateInRange(), getSelectedItemId(), detectInboxType()
 */

'use strict';

// ─── Guard: don't initialise twice on SPA navigations ─────────────────────
if (window.__dmExtractorLoaded) {
  // Re-inject panel if it got removed (MBS SPA can blow away the DOM)
  ensurePanelMounted();
} else {
  window.__dmExtractorLoaded = true;
  init();
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════

function init() {
  setupBridge();
  injectPanel();
  watchForSPANavigations();
}

// ─── Bridge object (shared between content.js, panel.js, DevTools) ─────────
let _bridge = null;

// Crawler state machine variables
let _state      = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
let _pauseResolve = null; // resolve fn for pause promise
let _stopSignal = false;

// Session deduplication
const _seenIds = new Set();

// Progress counters
let _stats = { downloaded: 0, skipped: 0, errors: 0, convIndex: 0, convTotal: 0 };

function setupBridge() {
  _bridge = {
    // Called by panel.js buttons
    start  : startCrawler,
    pause  : pauseCrawler,
    resume : resumeCrawler,
    stop   : stopCrawler,
    state  : () => _state,

    // Callbacks assigned by panel.js after it initialises
    onProgress : null,
    onLog      : null,
    onDone     : null,
    appendLog  : null,  // filled in by panel.js

    // DevTools shortcut — extract current open conversation
    extract    : extract,
    download   : download,
  };

  window.__dmExtractor  = _bridge;
  window.__obsidiaExtract = () => {
    const data = extract();
    if (data && !data.error) download(data);
    return data;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PANEL INJECTION
// ═══════════════════════════════════════════════════════════════════════════

let _shadowHost = null;

async function injectPanel() {
  // Prevent double-injection
  if (document.getElementById('dm-extractor-host')) return;

  _shadowHost = document.createElement('div');
  _shadowHost.id = 'dm-extractor-host';
  _shadowHost.style.cssText = 'all:unset;position:fixed;z-index:2147483647;';
  document.body.appendChild(_shadowHost);

  const shadow = _shadowHost.attachShadow({ mode: 'open' });

  // Load CSS
  const cssUrl  = chrome.runtime.getURL('panel.css');
  const htmlUrl = chrome.runtime.getURL('panel.html');

  try {
    const [cssText, htmlText] = await Promise.all([
      fetch(cssUrl).then(r => r.text()),
      fetch(htmlUrl).then(r => r.text()),
    ]);

    // Inject styles
    const style = document.createElement('style');
    style.textContent = cssText;
    shadow.appendChild(style);

    // Parse and inject panel HTML (take only the body contents)
    const tmp = document.createElement('div');
    tmp.innerHTML = htmlText;
    const body = tmp.querySelector('body');
    (body || tmp).childNodes.forEach(n => shadow.appendChild(n.cloneNode(true)));

    // Inject panel.js into shadow document context
    // We use a script appended to the MAIN document but reading from the
    // shadow host's document — simpler: eval the script with shadow scope trick.
    // Actually panel.js uses document.getElementById which won't work inside shadow.
    // We monkey-patch document.getElementById on a proxy document, OR we simply
    // pass the shadow root and have panel.js use shadowRoot.getElementById.
    // Cleanest MV3 approach: eval panel.js text with a patched getElementById.
    const jsUrl  = chrome.runtime.getURL('panel.js');
    const jsText = await fetch(jsUrl).then(r => r.text());

    // Create a minimal document proxy so panel.js getElementById resolves inside shadow.
    // ShadowRoot has no getElementById — use querySelector instead.
    const shadowDoc = {
      getElementById: (id) => shadow.querySelector('#' + id),
      createElement : (tag) => document.createElement(tag),
      addEventListener: document.addEventListener.bind(document),
    };

    // Wrap panel.js: replace global `document` references with shadowDoc
    // We achieve this by running panel.js inside a function that receives
    // a local `document` binding.
    const wrappedJs = `(function(document, window) { ${jsText} })(shadowDoc, window)`;
    // eslint-disable-next-line no-new-func
    new Function('shadowDoc', wrappedJs)(shadowDoc);

  } catch (err) {
    console.error('[DM Extractor] Panel injection failed:', err);
  }
}

function ensurePanelMounted() {
  if (!document.getElementById('dm-extractor-host')) {
    injectPanel();
  }
}

// Re-inject panel if MBS SPA navigation removes it
function watchForSPANavigations() {
  const observer = new MutationObserver(() => {
    if (!document.getElementById('dm-extractor-host')) {
      injectPanel();
    }
  });
  observer.observe(document.body, { childList: true, subtree: false });
}

// ═══════════════════════════════════════════════════════════════════════════
// EXTRACTION LOGIC  (ported from Obsidia content.js)
// ═══════════════════════════════════════════════════════════════════════════

/** Find the scrollable message list container. */
function findThreadRegion() {
  return document.querySelector('[aria-label*="Message list container" i]');
}

/** Extract the contact's display name from the open conversation header. */
function findCustomerName() {
  const selectors = [
    // Primary: conversation header h2/h3/h4
    'h2[dir="auto"]',
    'h3[dir="auto"]',
    'h4[dir="auto"]',
    // Fallback: aria-label on the conversation title element
    '[data-testid="conversation_name"]',
    '[aria-label*="conversation" i] strong',
    // Last resort: any strong in the top nav area
    'header strong',
    'nav strong',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return null;
}

/** Fall back to URL param if name not found in DOM. */
function findThreadTitle() {
  return findCustomerName() || getSelectedItemId() || 'unknown';
}

/**
 * Walk up the DOM from `node` toward `root` to determine message direction.
 * Returns 'inbound' | 'outbound' | 'unknown'.
 *
 * MBS uses class x1nhvcw1 for inbound bubbles and x13a6bvl for outbound.
 * These class names are obfuscated and may change; we fall back to
 * aria-label / data-* on the row if they shift.
 */
function nearestDirection(node, root) {
  let cur = node;
  while (cur && cur !== root) {
    if (cur.classList) {
      if (cur.classList.contains('x1nhvcw1')) return 'inbound';
      if (cur.classList.contains('x13a6bvl')) return 'outbound';
    }
    // Fallback: aria-label hints on row wrappers
    const label = cur.getAttribute && cur.getAttribute('aria-label');
    if (label) {
      if (/you sent/i.test(label) || /outgoing/i.test(label)) return 'outbound';
      if (/received/i.test(label) || /incoming/i.test(label)) return 'inbound';
    }
    cur = cur.parentElement;
  }
  return 'unknown';
}

/**
 * Extract clean text from a message bubble.
 * Clones the element, strips visually-hidden spans (aria-hidden, sr-only, etc.),
 * then returns trimmed text content.
 */
function bubbleText(bubble) {
  const clone = bubble.cloneNode(true);
  // Remove hidden / accessibility-only nodes
  clone.querySelectorAll(
    '[aria-hidden="true"], [class*="hidden"], .sr-only, [style*="display:none"], [style*="display: none"]'
  ).forEach(n => n.remove());
  return clone.textContent.trim();
}

/**
 * Walk the full thread DOM and collect all messages.
 *
 * Returns:
 * {
 *   thread        : string (title / contact name),
 *   customer_name : string,
 *   url           : string,
 *   extracted_at  : ISO string,
 *   count         : number,
 *   messages      : Array<{ id, date, direction, text, type }>
 * }
 *
 * On fatal error returns { error: string }.
 */
function extract() {
  const region = findThreadRegion();
  if (!region) return { error: 'Thread region not found — is a conversation open?' };

  const customerName  = findCustomerName();
  const threadTitle   = customerName || findThreadTitle();
  const messages      = [];

  // Walk every child of the region; maintain a running "current date" for messages
  let currentDate = null;

  const walker = document.createTreeWalker(region, NodeFilter.SHOW_ELEMENT);
  let node;

  while ((node = walker.nextNode())) {
    // ── Date divider ────────────────────────────────────────────────────
    // MBS date dividers have classes x14vqqas and xod5an3 (may shift)
    // More robustly: they are role="separator" or contain only a short date string
    if (
      (node.classList.contains('x14vqqas') && node.classList.contains('xod5an3')) ||
      (node.getAttribute('role') === 'separator' && node.textContent.trim().length < 40)
    ) {
      const label = node.textContent.trim();
      if (label) {
        currentDate = label; // store human-readable; parse later for filtering
      }
      continue;
    }

    // ── Message bubble ──────────────────────────────────────────────────
    const msgId = node.getAttribute('data-message-id') ||
                  node.getAttribute('data-mid');
    if (!msgId) continue;

    // Avoid duplicates (walker visits descendants too)
    if (messages.some(m => m.id === msgId)) continue;

    const text = bubbleText(node);
    if (!text) continue; // skip empty / media-only for now

    const direction = nearestDirection(node, region);

    // Seen / delivered receipt — small sub-text under the bubble
    let receipt = null;
    const receiptEl = node.querySelector('[data-testid="message_delivery_receipt"]') ||
                      node.querySelector('[aria-label*="Seen" i]') ||
                      node.querySelector('[aria-label*="Delivered" i]');
    if (receiptEl) receipt = receiptEl.getAttribute('aria-label') || receiptEl.textContent.trim();

    messages.push({
      id        : msgId,
      date      : currentDate,
      direction,
      text,
      receipt   : receipt || undefined,
      type      : 'text',
    });
  }

  return {
    thread       : threadTitle,
    customer_name: customerName,
    url          : window.location.href,
    extracted_at : new Date().toISOString(),
    count        : messages.length,
    messages,
  };
}

/**
 * Trigger a JSON file download.
 * Filename: dm_extractor_<name>_<timestamp>.json
 */
function download(data) {
  const name      = (data.customer_name || data.thread || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 60);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename  = `dm_extractor_${name}_${timestamp}.json`;

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

// ═══════════════════════════════════════════════════════════════════════════
// CRAWLER STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

const DELAY_BETWEEN_CONVS = 2500; // ms between conversations
const SCROLL_WAIT         = 1500; // ms to wait after scrolling for new items
const THREAD_LOAD_TIMEOUT = 8000; // ms to wait for thread DOM
const MAX_EMPTY_SCROLLS   = 2;    // stop scrolling after N non-productive scrolls

/**
 * Start the batch crawler.
 * @param {{ from: string, to: string }} opts  ISO date strings "YYYY-MM-DD"
 */
async function startCrawler({ from, to }) {
  if (_state === 'running') return;

  _state      = 'running';
  _stopSignal = false;
  _seenIds.clear();
  _stats = { downloaded: 0, skipped: 0, errors: 0, convIndex: 0, convTotal: 0 };

  const fromDate = new Date(from + 'T00:00:00');
  const toDate   = new Date(to   + 'T23:59:59');

  log('info', `Starting batch. Range: ${from} → ${to}`);
  log('info', `Inbox: ${detectInboxType()}`);

  emitProgress({ inbox: detectInboxType() });

  try {
    await runCrawl(fromDate, toDate);
  } catch (err) {
    log('err', 'Crawler error: ' + err.message);
  }

  if (_state !== 'stopped') _state = 'idle';
  emitDone();
}

function pauseCrawler()  { if (_state === 'running')  _state = 'paused';  }
function resumeCrawler() { if (_state === 'paused')   { _state = 'running'; if (_pauseResolve) _pauseResolve(); } }
function stopCrawler()   { _state = 'stopped'; _stopSignal = true; if (_pauseResolve) _pauseResolve(); }

/** Wait while paused, resolve immediately if not paused or if stopped. */
function waitIfPaused() {
  if (_state !== 'paused') return Promise.resolve();
  return new Promise(resolve => { _pauseResolve = resolve; });
}

// ─── Main crawl loop ─────────────────────────────────────────────────────

async function runCrawl(fromDate, toDate) {
  // Find the conversation list container (left sidebar)
  const listContainer = findConversationListContainer();
  if (!listContainer) {
    log('err', 'Could not find conversation list. Make sure an inbox is open.');
    return;
  }

  let processed = 0;
  let emptyScrollCount = 0;
  let previousItemCount = 0;

  while (!_stopSignal) {
    // Collect all currently-visible conversation rows
    const rows = getConversationRows(listContainer);
    const newRows = rows.filter(row => {
      const id = getRowId(row);
      return id && !_seenIds.has(id);
    });

    if (newRows.length === 0) {
      // No new rows — try scrolling to load more
      const currentCount = rows.length;
      if (currentCount === previousItemCount) {
        emptyScrollCount++;
        if (emptyScrollCount >= MAX_EMPTY_SCROLLS) {
          log('info', 'Reached end of conversation list.');
          break;
        }
      } else {
        emptyScrollCount = 0;
        previousItemCount = currentCount;
      }
      scrollListDown(listContainer);
      await sleep(SCROLL_WAIT);
      continue;
    }

    emptyScrollCount = 0;
    previousItemCount = rows.length;
    _stats.convTotal = _seenIds.size + newRows.length; // approximate
    emitProgress({ inbox: detectInboxType() });

    for (const row of newRows) {
      if (_stopSignal) break;
      await waitIfPaused();
      if (_stopSignal) break;

      const rowId = getRowId(row);
      _seenIds.add(rowId);
      processed++;
      _stats.convIndex = processed;

      const rowName = getRowName(row) || `#${processed}`;
      log('info', `Opening: ${rowName}`);
      emitProgress({ inbox: detectInboxType(), convName: rowName });

      // Click the row to open the conversation
      const prevConvId = getSelectedItemId();
      try {
        row.click();
      } catch {
        log('err', `Failed to click row: ${rowName}`);
        _stats.errors++;
        continue;
      }

      // Wait for the URL to reflect the new conversation before checking the DOM.
      // Without this, waitForElement resolves immediately against the previous thread.
      await waitForUrlChange(prevConvId, 3000);

      // Wait for new thread's message container to appear
      try {
        await waitForElement('[aria-label*="Message list container" i]', THREAD_LOAD_TIMEOUT);
      } catch {
        log('err', `Timed out loading thread: ${rowName}`);
        _stats.errors++;
        emitProgress({ inbox: detectInboxType(), convName: rowName });
        continue;
      }

      // Extra delay to let React finish rendering messages into the container
      await sleep(600);

      // Extract
      let data;
      try {
        data = extract();
      } catch (err) {
        log('err', `extract() threw for ${rowName}: ${err.message}`);
        _stats.errors++;
        emitProgress({ inbox: detectInboxType(), convName: rowName });
        continue;
      }

      if (!data || data.error) {
        log('err', `Extraction failed for ${rowName}: ${data ? data.error : 'null'}`);
        _stats.errors++;
        emitProgress({ inbox: detectInboxType(), convName: rowName });
        continue;
      }

      // Date-range filter
      const { filtered, filteredMessages } = filterByDateRange(data.messages, fromDate, toDate);

      if (filteredMessages.length === 0) {
        log('skip', `No messages in range: ${rowName}`);
        _stats.skipped++;
        emitProgress({ inbox: detectInboxType(), convName: rowName });
        await sleep(DELAY_BETWEEN_CONVS);
        continue;
      }

      // Build output object
      const output = {
        ...data,
        messages : filteredMessages,
        count    : filteredMessages.length,
      };
      if (filtered) {
        output.filtered    = true;
        output.filter_from = fromDate.toISOString().slice(0, 10);
        output.filter_to   = toDate.toISOString().slice(0, 10);
      }

      // Download (with one retry)
      let downloaded = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          download(output);
          downloaded = true;
          break;
        } catch (err) {
          if (attempt === 0) {
            log('err', `Download failed for ${rowName}, retrying…`);
            await sleep(500);
          }
        }
      }

      if (downloaded) {
        log('ok', `Downloaded (${filteredMessages.length} msgs): ${rowName}`);
        _stats.downloaded++;
      } else {
        log('err', `Download failed after retry: ${rowName}`);
        _stats.errors++;
      }

      emitProgress({ inbox: detectInboxType(), convName: rowName });
      await sleep(DELAY_BETWEEN_CONVS);
    }

    // After processing visible rows, scroll to load more
    scrollListDown(listContainer);
    await sleep(SCROLL_WAIT);
  }
}

// ─── Conversation list helpers ────────────────────────────────────────────

/**
 * Find the scrollable container that holds the conversation list rows.
 * Tries multiple known patterns in priority order.
 */
function findConversationListContainer() {
  // Pattern 1: explicit aria-label on the inbox list
  const byLabel = document.querySelector(
    '[aria-label*="conversation" i][role="list"],' +
    '[aria-label*="inbox" i][role="list"],' +
    '[aria-label*="chat" i][role="list"]'
  );
  if (byLabel) return byLabel;

  // Pattern 2: a scrollable div that contains multiple [role="row"] or [role="listitem"]
  const allLists = document.querySelectorAll('[role="list"], [role="listbox"], [role="grid"]');
  for (const list of allLists) {
    const rows = list.querySelectorAll('[role="row"], [role="listitem"], [role="option"]');
    if (rows.length >= 2) return list;
  }

  // Pattern 3: fall back to first large scrollable div in the left column
  const scrollables = document.querySelectorAll('div[style*="overflow"]');
  for (const el of scrollables) {
    const rect = el.getBoundingClientRect();
    // Left side of viewport, taller than 300px
    if (rect.left < 400 && rect.height > 300) return el;
  }

  return null;
}

/**
 * Get all conversation row elements from the list container.
 * Uses role="row" | role="listitem" | role="option" as primary selector,
 * falls back to direct children with known structural depth.
 */
function getConversationRows(container) {
  const rows = container.querySelectorAll('[role="row"], [role="listitem"], [role="option"]');
  if (rows.length) return Array.from(rows);

  // Fallback: direct children that look like conversation rows (have a link or clickable)
  return Array.from(container.children).filter(el =>
    el.querySelector('a[href*="selected_item_id"]') ||
    el.getAttribute('data-testid')
  );
}

/**
 * Extract a stable identifier for a conversation row.
 * Tries data-id, href param, aria-label hash.
 */
function getRowId(row) {
  // Try anchor href
  const link = row.querySelector('a[href*="selected_item_id"]');
  if (link) {
    const id = new URL(link.href, window.location.origin).searchParams.get('selected_item_id');
    if (id) return id;
  }
  // Try data attributes
  const dataId = row.getAttribute('data-id') || row.getAttribute('data-thread-id');
  if (dataId) return dataId;

  // Last resort: stable-ish text hash
  const name = getRowName(row);
  return name ? 'name:' + name : null;
}

/** Extract display name from a conversation row element. */
function getRowName(row) {
  // Prefer a named heading-like element
  for (const sel of ['[role="heading"]', 'strong', 'b', 'span[dir="auto"]']) {
    const el = row.querySelector(sel);
    if (el && el.textContent.trim()) return el.textContent.trim();
  }
  return row.getAttribute('aria-label') || null;
}

/** Scroll the list container down by its visible height to trigger lazy loading. */
function scrollListDown(container) {
  container.scrollTop += container.clientHeight || 400;
}

/**
 * Wait until the page URL's selected_item_id differs from `prevId`, or timeout.
 * Always resolves (never rejects) — caller proceeds regardless.
 */
function waitForUrlChange(prevId, timeout = 3000) {
  return new Promise(resolve => {
    if (getSelectedItemId() !== prevId) { resolve(); return; }
    const deadline = Date.now() + timeout;
    const interval = setInterval(() => {
      if (getSelectedItemId() !== prevId || Date.now() >= deadline) {
        clearInterval(interval);
        resolve();
      }
    }, 100);
  });
}

// ─── Date range filtering ─────────────────────────────────────────────────

/**
 * Filter messages array to only those within [fromDate, toDate].
 * Messages with no parseable date are included conservatively.
 *
 * @param {Array} messages
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {{ filtered: boolean, filteredMessages: Array }}
 */
function filterByDateRange(messages, fromDate, toDate) {
  let currentDate = null;
  let anyFiltered = false;

  // First pass: assign resolved Date objects to each message
  const annotated = messages.map(msg => {
    if (msg.date && msg.date !== currentDate) {
      currentDate = msg.date;
    }
    const parsed = parseDateLabel(currentDate);
    return { ...msg, _parsedDate: parsed };
  });

  const inRange = annotated.filter(msg => dateInRange(msg._parsedDate, fromDate, toDate));

  // Check if we actually dropped anything
  if (inRange.length !== messages.length) anyFiltered = true;

  // Remove internal annotation before returning
  const filteredMessages = inRange.map(({ _parsedDate, ...rest }) => rest);

  return { filtered: anyFiltered, filteredMessages };
}

// ─── Bridge event emitters ────────────────────────────────────────────────

function emitProgress(extra = {}) {
  if (_bridge && _bridge.onProgress) {
    _bridge.onProgress({ ..._stats, ...extra });
  }
}

function emitDone() {
  if (_bridge && _bridge.onDone) {
    _bridge.onDone({ ..._stats });
  }
}

function log(type, message) {
  console[type === 'err' ? 'error' : 'log'](`[DM Extractor] ${message}`);
  if (_bridge && _bridge.onLog) _bridge.onLog(message, type);
}
