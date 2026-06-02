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

// ─── Module-level state (must be declared before the guard block runs) ──────
let _bridge       = null;
let _state        = 'idle'; // 'idle' | 'running' | 'paused' | 'stopped'
let _pauseResolve = null;
let _stopSignal   = false;
let _shadowHost   = null;
const _seenIds    = new Set();
let _stats        = { downloaded: 0, skipped: 0, errors: 0, convIndex: 0, convTotal: 0 };

// ─── Guard: don't initialise twice on SPA navigations ─────────────────────
if (window.__dmExtractorLoaded) {
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

    // Wire up panel UI directly — no eval needed, avoids page CSP restrictions
    initPanelUI(shadow);

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
// PANEL UI  (runs inside the shadow DOM — no eval, no CSP issues)
// ═══════════════════════════════════════════════════════════════════════════

function initPanelUI(shadow) {
  const $ = id => shadow.querySelector('#' + id);

  const panel       = $('dm-panel');
  const collapseBtn = $('dm-collapse-btn');
  const fromInput   = $('dm-from');
  const toInput     = $('dm-to');
  const startBtn    = $('dm-start-btn');
  const pauseBtn    = $('dm-pause-btn');
  const stopBtn     = $('dm-stop-btn');
  const progressBar = $('dm-progress-bar');
  const statusInbox = $('dm-status-inbox');
  const statusConv  = $('dm-status-conv');
  const countDl     = $('dm-count-dl');
  const countSkip   = $('dm-count-skip');
  const countErr    = $('dm-count-err');
  const logEl       = $('dm-log');

  // Default date range: current calendar month
  const now   = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  fromInput.value = first.toISOString().slice(0, 10);
  toInput.value   = now.toISOString().slice(0, 10);

  // ── Collapse / expand ────────────────────────────────────────────────────
  collapseBtn.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    collapseBtn.textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
  });

  // ── Drag to reposition ───────────────────────────────────────────────────
  let dragging = false, dragOffX = 0, dragOffY = 0;
  $('dm-header').addEventListener('mousedown', e => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffX = e.clientX - rect.left;
    dragOffY = e.clientY - rect.top;
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    panel.style.right  = 'unset';
    panel.style.bottom = 'unset';
    panel.style.left   = (e.clientX - dragOffX) + 'px';
    panel.style.top    = (e.clientY - dragOffY) + 'px';
  });
  document.addEventListener('mouseup', () => { dragging = false; });

  // ── Buttons ──────────────────────────────────────────────────────────────
  startBtn.addEventListener('click', () => {
    const from = fromInput.value;
    const to   = toInput.value;
    if (!from || !to) { appendLog('Please set both From and To dates.', 'err'); return; }
    if (from > to)    { appendLog('"From" must be before "To".', 'err'); return; }
    setButtons('running');
    _bridge.start({ from, to });
  });

  pauseBtn.addEventListener('click', () => {
    if (_bridge.state() === 'paused') {
      setButtons('running');
      _bridge.resume();
    } else {
      setButtons('paused');
      _bridge.pause();
    }
  });

  stopBtn.addEventListener('click', () => {
    _bridge.stop();
    setButtons('idle');
  });

  // ── Bridge callbacks ─────────────────────────────────────────────────────
  _bridge.onProgress = info => {
    statusInbox.innerHTML = 'Inbox: <span class="dm-inbox-label">' +
      escHtml(info.inbox || '—') + '</span>';
    if (info.convTotal > 0) {
      statusConv.textContent =
        `Conversation: ${info.convIndex} / ${info.convTotal}` +
        (info.convName ? ` — ${truncate(info.convName, 24)}` : '');
      progressBar.style.width = Math.round((info.convIndex / info.convTotal) * 100) + '%';
    } else {
      statusConv.textContent = 'Scanning conversations…';
    }
    countDl.textContent   = 'Downloaded: ' + (info.downloaded || 0);
    countSkip.textContent = 'Skipped: '    + (info.skipped    || 0);
    countErr.textContent  = 'Errors: '     + (info.errors     || 0);
  };

  _bridge.onLog  = (message, type) => appendLog(message, type || 'info');

  _bridge.onDone = summary => {
    setButtons('idle');
    progressBar.style.width = '100%';
    appendLog(
      `Done. Downloaded: ${summary.downloaded}  Skipped: ${summary.skipped}  Errors: ${summary.errors}`,
      'ok'
    );
  };

  _bridge.appendLog = appendLog;

  // ── Helpers ──────────────────────────────────────────────────────────────
  function setButtons(state) {
    if (state === 'idle') {
      startBtn.disabled = false; pauseBtn.disabled = true; stopBtn.disabled = true;
      pauseBtn.textContent = '⏸ Pause';
      fromInput.disabled = false; toInput.disabled = false;
    } else if (state === 'running') {
      startBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false;
      pauseBtn.textContent = '⏸ Pause';
      fromInput.disabled = true; toInput.disabled = true;
    } else if (state === 'paused') {
      pauseBtn.textContent = '▶ Resume';
    }
  }

  function appendLog(message, type) {
    const line = document.createElement('div');
    line.className = 'log-' + (type || 'info');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    logEl.appendChild(line);
    while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }
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
  const listContainer = findConversationListContainer();
  if (!listContainer) {
    log('err', 'Could not find conversation list. Make sure an inbox is open.');
    return;
  }
  log('info', 'Conversation list container found.');

  let processed = 0;
  let emptyScrollCount = 0;
  let previousItemCount = 0;

  while (!_stopSignal) {
    const items = getConversationItems(listContainer);
    const newItems = items.filter(item => !_seenIds.has(item.id));

    if (newItems.length === 0) {
      const currentCount = items.length;
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
    previousItemCount = items.length;
    _stats.convTotal = _seenIds.size + newItems.length;
    emitProgress({ inbox: detectInboxType() });

    for (const item of newItems) {
      if (_stopSignal) break;
      await waitIfPaused();
      if (_stopSignal) break;

      _seenIds.add(item.id);
      processed++;
      _stats.convIndex = processed;

      log('info', `Opening: ${item.name || item.id}`);
      emitProgress({ inbox: detectInboxType(), convName: item.name || item.id });

      // Navigate — tries clicking the row and its ancestors until the URL changes
      const navigated = await navigateToConversation(item);
      if (!navigated) {
        log('err', `Could not navigate to conversation ${item.id} — skipping`);
        _stats.errors++;
        emitProgress({ inbox: detectInboxType() });
        continue;
      }

      // Wait for the thread message container to load
      try {
        await waitForElement('[aria-label*="Message list container" i]', THREAD_LOAD_TIMEOUT);
      } catch {
        log('err', `Timed out loading thread: ${item.name || item.id}`);
        _stats.errors++;
        emitProgress({ inbox: detectInboxType() });
        continue;
      }

      // Let React finish rendering messages
      await sleep(700);

      // Extract
      let data;
      try {
        data = extract();
      } catch (err) {
        log('err', `extract() threw: ${err.message}`);
        _stats.errors++;
        emitProgress({ inbox: detectInboxType() });
        continue;
      }

      if (!data || data.error) {
        log('err', `Extraction failed: ${data ? data.error : 'null'}`);
        _stats.errors++;
        emitProgress({ inbox: detectInboxType() });
        continue;
      }

      // Date-range filter
      const { filtered, filteredMessages } = filterByDateRange(data.messages, fromDate, toDate);

      if (filteredMessages.length === 0) {
        log('skip', `No messages in range: ${item.name || item.id}`);
        _stats.skipped++;
        emitProgress({ inbox: detectInboxType() });
        await sleep(DELAY_BETWEEN_CONVS);
        continue;
      }

      const output = { ...data, messages: filteredMessages, count: filteredMessages.length };
      if (filtered) {
        output.filtered    = true;
        output.filter_from = fromDate.toISOString().slice(0, 10);
        output.filter_to   = toDate.toISOString().slice(0, 10);
      }

      let downloaded = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { download(output); downloaded = true; break; }
        catch (err) { if (attempt === 0) { log('err', `Download failed, retrying…`); await sleep(500); } }
      }

      if (downloaded) {
        log('ok', `Downloaded (${filteredMessages.length} msgs): ${item.name || item.id}`);
        _stats.downloaded++;
      } else {
        log('err', `Download failed after retry: ${item.name || item.id}`);
        _stats.errors++;
      }

      emitProgress({ inbox: detectInboxType() });
      await sleep(DELAY_BETWEEN_CONVS);
    }

    scrollListDown(listContainer);
    await sleep(SCROLL_WAIT);
  }
}

// ─── Conversation list helpers ────────────────────────────────────────────

/**
 * Find the scrollable sidebar container.
 * Strictly filters to the LEFT half of the viewport so we never pick up the
 * thread pane, which also contains a[href*="selected_item_id"] links.
 */
function findConversationListContainer() {
  const half = window.innerWidth / 2;

  // Best signal: find a sidebar anchor, walk up to its scrollable ancestor
  const allLinks = Array.from(document.querySelectorAll('a[href*="selected_item_id"]'));
  const sidebarLink = allLinks.find(a => {
    const r = a.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left < half;
  });

  if (sidebarLink) {
    let el = sidebarLink.parentElement;
    while (el && el !== document.body) {
      const { overflow, overflowY } = window.getComputedStyle(el);
      if (/auto|scroll/.test(overflow + overflowY) && el.scrollHeight > el.clientHeight + 20) {
        console.log('[DM Extractor] Sidebar container (from anchor):', el.tagName, el.scrollHeight, '>', el.clientHeight);
        return el;
      }
      el = el.parentElement;
    }
  }

  // Fallback: leftmost large scrollable div
  for (const el of document.querySelectorAll('div')) {
    const r = el.getBoundingClientRect();
    if (r.left > half || r.height < 300 || r.width < 100) continue;
    const { overflow, overflowY } = window.getComputedStyle(el);
    if (/auto|scroll/.test(overflow + overflowY) && el.scrollHeight > el.clientHeight + 50) {
      console.log('[DM Extractor] Sidebar container (fallback):', el.tagName, el.scrollHeight);
      return el;
    }
  }

  return null;
}

/**
 * Collect all visible conversation items from the sidebar container.
 * Returns Array<{ id, href, name, anchor, row }>
 *
 * `row` is the direct child of `container` that wraps the conversation —
 * this is what we click, not the <a> itself, because React's onClick handler
 * is typically on the row div, not the inner anchor.
 */
function getConversationItems(container) {
  const half = window.innerWidth / 2;
  const seen = new Set();
  const items = [];

  const links = container.querySelectorAll('a[href*="selected_item_id"]');
  for (const anchor of links) {
    // Skip anything that renders on the right side (thread pane, etc.)
    const rect = anchor.getBoundingClientRect();
    if (rect.left >= half || rect.width === 0) continue;

    let id;
    try { id = new URL(anchor.href).searchParams.get('selected_item_id'); } catch { continue; }
    if (!id || seen.has(id)) continue;
    seen.add(id);

    // Walk up to the direct child of container — that's the clickable row div
    let row = anchor;
    while (row.parentElement && row.parentElement !== container) {
      row = row.parentElement;
    }

    // Extract name from within the row
    let name = null;
    for (const sel of ['[role="heading"]', 'strong', 'b', 'span[dir="auto"]']) {
      const el = row.querySelector(sel);
      if (el && el.textContent.trim()) { name = el.textContent.trim(); break; }
    }
    if (!name) name = anchor.getAttribute('aria-label') || anchor.getAttribute('title') || null;

    items.push({ id, href: anchor.href, name, anchor, row });
  }

  return items;
}

/**
 * Navigate to a conversation by clicking its row and verifying the URL changes.
 * Tries the row element, then walks up ancestors, because MBS's React onClick
 * handler may be on a parent div rather than the <a> itself.
 */
async function navigateToConversation(item) {
  if (getSelectedItemId() === item.id) return true;

  // Scroll into view so the element is in the rendered viewport
  try { item.anchor.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch {}
  await sleep(150);

  // Try clicking from the row up through 6 ancestor levels
  let el = item.row;
  for (let i = 0; i < 6 && el && el !== document.body; i++, el = el.parentElement) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (await waitForSpecificId(item.id, 1500)) return true;
  }

  // Final attempt: click the anchor itself
  item.anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return waitForSpecificId(item.id, 2000);
}

/**
 * Wait until selected_item_id in the URL equals targetId, or timeout.
 * Resolves true if matched, false on timeout.
 */
function waitForSpecificId(targetId, timeout) {
  return new Promise(resolve => {
    if (getSelectedItemId() === targetId) { resolve(true); return; }
    const deadline = Date.now() + timeout;
    const iv = setInterval(() => {
      if (getSelectedItemId() === targetId) { clearInterval(iv); resolve(true); }
      else if (Date.now() >= deadline)      { clearInterval(iv); resolve(false); }
    }, 100);
  });
}

/** Scroll the sidebar container down to trigger virtual-scroll loading. */
function scrollListDown(container) {
  container.scrollTop += container.clientHeight || 400;
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
