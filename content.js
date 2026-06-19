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
    const x = Math.max(0, Math.min(e.clientX - dragOffX, window.innerWidth  - panel.offsetWidth));
    const y = Math.max(0, Math.min(e.clientY - dragOffY, window.innerHeight - panel.offsetHeight));
    panel.style.left = x + 'px';
    panel.style.top  = y + 'px';
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
  const el = document.querySelector('[aria-label*="Message list container" i]');
  if (el) return el;

  // Localised aria-label or changed element role: find a large list/log/feed
  // element in the right portion of the viewport (not the narrow left sidebar).
  const minLeft = window.innerWidth * 0.3;
  for (const c of document.querySelectorAll('[role="list"],[role="log"],[role="feed"]')) {
    const r = c.getBoundingClientRect();
    if (r.left >= minLeft && r.width >= 200 && r.height >= 200) return c;
  }
  return null;
}

/** Extract the contact's display name from the open conversation header. */
function findCustomerName() {
  // WEC/WhatsApp: the conversation detail header (BizInboxDetailViewHeaderSectionWrapper)
  // shows the contact's display name in a _4ik4._4ik5 title line. This is more reliable
  // than the sidebar row name (which may show a phone number instead of a display name).
  const detailHeader = document.querySelector('[data-pagelet="BizInboxDetailViewHeaderSectionWrapper"]');
  if (detailHeader) {
    const nameEl = detailHeader.querySelector('._4ik4._4ik5');
    if (nameEl) {
      const t = cleanText(nameEl);
      if (t) return t;
    }
  }

  // Also check data-surface attribute path for the detail view header.
  const detailSurface = document.querySelector('[data-surface*="detail_view_header"] ._4ik4._4ik5');
  if (detailSurface) {
    const t = cleanText(detailSurface);
    if (t) return t;
  }

  const selectors = [
    'h1[dir="auto"]', 'h2[dir="auto"]', 'h3[dir="auto"]', 'h4[dir="auto"]',
    '[data-testid="conversation_name"]',
    '[aria-label*="conversation" i] strong',
    '[role="main"] [role="heading"]',
    '[role="complementary"] [role="heading"]',
    'header [dir="auto"]', 'header strong', 'nav strong',
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) {
      const t = cleanText(el);
      if (t) return t;
    }
  }

  // WEC/WhatsApp: contact name renders as a leaf <div tabindex="-1"> in the
  // conversation header (confirmed via DevTools: <div tabindex="-1">Ani Khmaladze</div>).
  // Guards: must be in the top quarter of the viewport (header area, not message bubbles),
  // must be single-line, and must be short (names ≤ 60 chars; message text is longer).
  for (const div of document.querySelectorAll('div[tabindex="-1"]')) {
    if (div.children.length > 0) continue;
    const t = div.textContent.trim();
    if (!t || t.length > 60 || t.includes('\n')) continue;
    const r = div.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) continue;
    if (r.left > window.innerWidth * 0.75) continue;  // not in the right info panel
    if (r.top  > window.innerHeight * 0.25) continue; // header is in the top quarter
    return t;
  }

  // Instagram: thread title sometimes lives in a <span> inside the thread header
  // area (right pane top bar) — look for short non-empty text in the top strip.
  const half = window.innerWidth / 2;
  for (const span of document.querySelectorAll('span[dir="auto"], span')) {
    const t = cleanText(span);
    if (!t || t.length < 2 || t.length > 80) continue;
    if (span.children.length > 2) continue; // avoid picking up message bubbles
    const r = span.getBoundingClientRect();
    if (r.top > window.innerHeight * 0.12) continue; // top bar only
    if (r.left < half * 0.5) continue;               // right pane only
    if (r.width < 5 || r.height < 5) continue;
    return t;
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

  // Position-based fallback: outbound bubbles sit on the right side of the thread,
  // inbound on the left. More robust than obfuscated class names when Meta redeploys.
  try {
    const nodeRect = node.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width > 0) {
      const relX = (nodeRect.left + nodeRect.width / 2 - rootRect.left) / rootRect.width;
      if (relX > 0.55) return 'outbound';
      if (relX < 0.45) return 'inbound';
    }
  } catch {}

  return 'unknown';
}

/**
 * Extract clean text from a message bubble.
 * Clones the element, strips visually-hidden spans (aria-hidden, sr-only, etc.),
 * then returns trimmed text content.
 */
function bubbleText(bubble) {
  const clone = bubble.cloneNode(true);
  // Remove accessibility-only and explicitly hidden nodes.
  // Note: [class*="hidden"] is intentionally omitted — it is too broad and
  // matches Meta's obfuscated class names that contain the word "hidden" even
  // on fully visible message text elements.
  clone.querySelectorAll(
    '[aria-hidden="true"], .sr-only, [style*="display:none"], [style*="display: none"]'
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

  const seenMsgIds = new Set();
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
    const primaryId = node.getAttribute('data-message-id') ||
                      node.getAttribute('data-mid') ||
                      node.getAttribute('data-msgid');
    const groupId   = node.getAttribute('data-focusable-id') ||
                      node.getAttribute('data-item-id');
    const msgId = primaryId || groupId;
    if (!msgId) continue;

    // If this element only has a group-level ID (data-focusable-id / data-item-id)
    // and contains children with finer-grained message IDs, skip it so the
    // individual children are captured separately instead of being merged into one entry.
    if (!primaryId && groupId) {
      const hasMessageChildren = node.querySelector(
        '[data-message-id],[data-mid],[data-msgid]'
      );
      if (hasMessageChildren) continue;
    }

    // Avoid duplicates (walker visits descendants too)
    if (seenMsgIds.has(msgId)) continue;
    seenMsgIds.add(msgId);

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

  // Structural fallback: when no data-attribute message IDs exist in the DOM
  // (e.g. WEC / WhatsApp Business inbox after a Meta DOM update), collect text
  // bubbles via dir="auto" elements instead.
  if (messages.length === 0) {
    let synIdx = 0;
    const seenKeys = new Set();
    for (const el of region.querySelectorAll('[dir="auto"]')) {
      if (el.closest('[aria-hidden="true"]') || el.closest('[role="button"]')) continue;
      const text = bubbleText(el);
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 5 || r.width < 5) continue;
      const key = `${Math.round(r.top / 5)}_${text.slice(0, 40)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const direction = nearestDirection(el, region);
      messages.push({
        id        : `synth_${synIdx++}`,
        date      : currentDate,
        direction,
        text,
        type      : 'text',
      });
    }
    if (messages.length > 0)
      console.log(`[DM Extractor] Structural fallback: ${messages.length} messages via dir="auto"`);
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
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
}

// ═══════════════════════════════════════════════════════════════════════════
// CRAWLER STATE MACHINE
// ═══════════════════════════════════════════════════════════════════════════

const DELAY_BETWEEN_CONVS = 2500; // ms between conversations
const SCROLL_WAIT         = 1500; // ms to wait after scrolling for new items
const THREAD_LOAD_TIMEOUT = 8000; // ms to wait for thread DOM
const MAX_EMPTY_SCROLLS   = 6;    // stop scrolling after N non-productive scrolls

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
function resumeCrawler() {
  if (_state === 'paused') {
    _state = 'running';
    if (_pauseResolve) { const r = _pauseResolve; _pauseResolve = null; r(); }
  }
}
function stopCrawler() {
  _state = 'stopped';
  _stopSignal = true;
  if (_pauseResolve) { const r = _pauseResolve; _pauseResolve = null; r(); }
}

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
  await sleep(500); // brief wait for virtual-list rows to render

  let processed = 0;
  let emptyScrolls = 0;
  let consecutiveTooOld = 0;
  let seenTooNew = false; // true once a conversation newer than toDate is encountered
  const MAX_CONSECUTIVE_TOO_OLD = 3;

  while (!_stopSignal) {
    await waitIfPaused();
    if (_stopSignal) break;

    // Re-discover visible items every iteration to get a fresh DOM reference.
    // Virtual scroll recycles DOM nodes; cached references go stale and cause
    // navigation to fail or land on the wrong conversation.
    const items = getConversationItems(listContainer);
    const item  = items.find(i => !_seenIds.has(i.id));

    if (!item) {
      if (++emptyScrolls >= MAX_EMPTY_SCROLLS) {
        log('info', 'Reached end of conversation list.');
        break;
      }
      scrollListDown(listContainer);
      await sleep(SCROLL_WAIT);
      continue;
    }

    emptyScrolls = 0;
    _seenIds.add(item.id);
    processed++;
    _stats.convIndex = processed;
    _stats.convTotal = _seenIds.size + items.filter(i => !_seenIds.has(i.id)).length;

    log('info', `Opening: ${item.name || item.id}`);
    emitProgress({ inbox: detectInboxType(), convName: item.name || item.id });

    const navigated = await navigateToConversation(item);
    if (checkForDoneTrigger(`navigating to ${item.name || item.id}`)) break;
    if (!navigated) {
      log('err', `Could not navigate to: ${item.name || item.id} — skipping`);
      _stats.errors++;
      emitProgress({ inbox: detectInboxType() });
      continue;
    }

    if (item.realId) {
      if (_seenIds.has(item.realId)) {
        log('info', `Skipping duplicate: ${item.name || item.realId}`);
        _stats.skipped++;
        emitProgress({ inbox: detectInboxType() });
        continue;
      }
      _seenIds.add(item.realId);
    }

    try {
      await waitForElement('[aria-label*="Message list container" i]', THREAD_LOAD_TIMEOUT);
    } catch {
      log('err', `Timed out loading thread: ${item.name || item.id}`);
      _stats.errors++;
      emitProgress({ inbox: detectInboxType() });
      continue;
    }

    // Wait until the message count stops growing before extracting.
    // MBS loads bubbles progressively; a fixed sleep grabs only the first batch.
    await waitForCountStable(
      '[data-message-id],[data-mid],[data-msgid],[data-focusable-id],[data-item-id]',
      { timeout: 6000, interval: 250, stableRounds: 3 }
    );

    let data;
    try { data = extract(); }
    catch (err) {
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

    // Sidebar row name is more reliable than DOM header extraction for WEC
    if (!data.customer_name && item.name) {
      data.customer_name = item.name;
      data.thread        = item.name;
    }

    const { filtered, filteredMessages, tooOld } = filterByDateRange(data.messages, fromDate, toDate);

    if (filteredMessages.length === 0) {
      log('skip', `No messages in range: ${item.name || item.id}`);
      _stats.skipped++;
      emitProgress({ inbox: detectInboxType() });
      if (tooOld) {
        consecutiveTooOld++;
        // Only stop early once we've confirmed we're past the in-range window:
        // either we already downloaded some in-range conversations, or we've
        // seen too-new conversations (meaning we passed through the target
        // date band without finding anything). Without this guard a few pinned
        // or unread-first conversations from before fromDate at the top of the
        // list would fire the stop before the target range is ever reached.
        if (consecutiveTooOld >= MAX_CONSECUTIVE_TOO_OLD && (seenTooNew || _stats.downloaded > 0)) {
          log('info', `Stopped early: ${MAX_CONSECUTIVE_TOO_OLD} consecutive conversations older than start date.`);
          break;
        }
      } else {
        seenTooNew = true;
        consecutiveTooOld = 0;
      }
      await sleep(DELAY_BETWEEN_CONVS);
      continue;
    }

    consecutiveTooOld = 0;

    const output = {
      ...data,
      messages   : filteredMessages,
      count      : filteredMessages.length,
      filter_from: fromDate.toISOString().slice(0, 10),
      filter_to  : toDate.toISOString().slice(0, 10),
    };

    let downloaded = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { download(output); downloaded = true; break; }
      catch (err) { if (attempt === 0) { log('err', 'Download failed, retrying…'); await sleep(500); } }
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
 * Collect visible conversation items from the sidebar container.
 * Returns Array<{ id, href, name, anchor, row, realId? }>
 *
 * Strategy A — anchor-based: works for Messenger / Instagram which render
 *   <a href="...?selected_item_id=X"> in the sidebar.
 * Strategy B — structure-based: works for WEC / WhatsApp which render React
 *   divs with no anchor href; rows are identified as direct children of the
 *   container that have a typical row height and are on the left side.
 *   `realId` is populated later by navigateToConversation() after the URL changes.
 */
function getConversationItems(container) {
  const half = window.innerWidth / 2;

  // ── Strategy A ───────────────────────────────────────────────────────────
  const links = Array.from(container.querySelectorAll('a[href*="selected_item_id"]')).filter(a => {
    const r = a.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left < half;
  });

  if (links.length > 0) {
    const seen = new Set();
    const items = [];
    for (const anchor of links) {
      let id;
      try { id = new URL(anchor.href).searchParams.get('selected_item_id'); } catch { continue; }
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let row = anchor;
      while (row.parentElement && row.parentElement !== container) row = row.parentElement;
      const name = extractRowName(row) || anchor.getAttribute('aria-label') || null;
      items.push({ id, href: anchor.href, name, anchor, row });
    }
    if (items.length > 0) {
      console.log('[DM Extractor] Strategy A:', items.length, 'items');
      return items;
    }
  }

  // ── Strategy B ───────────────────────────────────────────────────────────
  // Descend through single-child wrappers (virtualization layers) up to 6 levels deep.
  let level = container;
  for (let depth = 0; depth < 6; depth++) {
    const children = Array.from(level.children);

    // Look for children that match a typical conversation row shape
    const rows = children.filter(el => {
      const r = el.getBoundingClientRect();
      if (!(r.height >= 50 && r.height <= 220 && r.width > 80 && r.left < half && r.left >= 0)) return false;
      // Skip placeholder / loading rows (e.g. "ჩატვირთვა…" = "Loading…")
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      return text.length >= 4 && !/^[.…]+$/.test(text);
    });

    if (rows.length >= 2) {
      console.log(`[DM Extractor] Strategy B: ${rows.length} rows at depth ${depth}`);
      return rows.map(row => {
        const name = extractRowName(row);
        // Fingerprint = first 80 chars of text, used as a temporary ID until real
        // selected_item_id is known (after clicking opens the conversation).
        const fp = 'fp:' + row.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
        return { id: fp, href: null, name, anchor: null, row };
      });
    }

    if (children.length === 1) {
      // Single child → likely a virtualization wrapper, go deeper
      level = children[0];
    } else if (children.length > 1) {
      // Multiple children but no rows matched yet — the found container may be a
      // broader sidebar that also holds a search box, filter tabs, or restriction
      // banners alongside the actual conversation list. Pick the tallest left-side
      // child (most likely the conversation list wrapper) and descend into it.
      const candidate = children
        .filter(el => { const r = el.getBoundingClientRect(); return r.left < half && r.height > 100 && r.width > 80; })
        .sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0];
      if (candidate && candidate !== level) {
        console.log(`[DM Extractor] Strategy B depth ${depth}: ${children.length} siblings, descending into tallest (${Math.round(candidate.getBoundingClientRect().height)}px)`);
        level = candidate;
      } else {
        break;
      }
    } else {
      break;
    }
  }

  // ── Strategy C: deep flat scan ───────────────────────────────────────────
  // Fallback when Strategy B's level-by-level descent misses rows (e.g. WEC
  // virtual lists where the row elements are at an unexpected depth or branch).
  // querySelectorAll('*') finds rows at any depth; the outer-row filter keeps
  // only the outermost matching element per conversation (not its inner spans).
  const allEls = Array.from(container.querySelectorAll('*'));
  const rowCandidates = allEls.filter(el => {
    const r = el.getBoundingClientRect();
    if (!(r.height >= 50 && r.height <= 220 && r.width > 100 && r.left < half && r.left >= 0)) return false;
    const text = el.textContent.replace(/\s+/g, ' ').trim();
    return text.length >= 4 && text.length <= 400 && !/^[.…]+$/.test(text);
  });
  const outerRows = rowCandidates.filter(el =>
    !rowCandidates.some(other => other !== el && other.contains(el))
  );
  if (outerRows.length > 0) {
    console.log('[DM Extractor] Strategy C (deep):', outerRows.length, 'rows');
    const seen = new Set();
    return outerRows
      .filter(row => {
        const fp = row.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
        if (seen.has(fp)) return false;
        seen.add(fp);
        return true;
      })
      .map(row => ({
        id  : 'fp:' + row.textContent.replace(/\s+/g, ' ').trim().slice(0, 80),
        href: null,
        name: extractRowName(row),
        anchor: null,
        row,
      }));
  }

  console.log('[DM Extractor] No rows found in container');
  return [];
}

/** Pull the contact name out of a conversation row element. */
/** Return text from el with aria-hidden descendants stripped (prevents duplicated names). */
function cleanText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

function extractRowName(el) {
  // WEC/WhatsApp: contact name is wrapped in a span with data-surface ending in
  // "thread_title". This works for any script (Georgian, Cyrillic, Latin, etc.).
  const titleNode = el.querySelector('[data-surface*="thread_title"]');
  if (titleNode) {
    const t = cleanText(titleNode);
    if (t) return t;
  }

  for (const sel of ['[role="heading"]', 'strong', 'b', 'span[dir="auto"]']) {
    const found = el.querySelector(sel);
    if (found) {
      const t = cleanText(found);
      if (t) return t;
    }
  }
  const label = el.getAttribute('aria-label');
  if (label) return label.split(',')[0].trim() || label.trim();
  const title = el.getAttribute('title');
  if (title) return title.trim();
  // WEC rows: contact name/phone comes first in textContent before any Georgian message text.
  const text = cleanText(el);
  const latinPrefix = text.match(/^([A-Za-z0-9 +\-_.@]{1,60})(?=[ა-ჿ]|$)/);
  if (latinPrefix && latinPrefix[1].trim()) return latinPrefix[1].trim();
  return null;
}

/**
 * Navigate to a conversation by clicking its row.
 *
 * Tries multiple strategies in order, stopping as soon as selected_item_id changes:
 *   1. Native anchor .click() inside the row (isTrusted, follows href)
 *   2. Data-attribute conversation ID → history.pushState (bypasses click)
 *   3. React fiber traversal — calls onMouseDown/onClick handler directly
 *   4. Full pointer+mouse sequence on every element at the row's center point
 *   5. Same sequence on the row and its ancestors
 */
async function navigateToConversation(item) {
  if (!document.body.contains(item.row)) return false;

  // block:'nearest' causes the minimum sidebar scroll needed to make the row
  // visible; 'center' was scrolling too much and triggering virtual-scroll recycling
  try { item.row.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } catch {}
  await sleep(250);

  if (!document.body.contains(item.row)) return false;

  const prevId = getSelectedItemId();

  // ── Anchor-based (Messenger / Instagram) ─────────────────────────────────
  if (item.href) {
    let targetId;
    try { targetId = new URL(item.href).searchParams.get('selected_item_id'); } catch {}
    if (targetId) {
      if (getSelectedItemId() === targetId) return true;
      if (item.anchor) {
        item.anchor.click();
        if (await waitForSpecificId(targetId, 2000)) return true;
      }
      let el = item.row;
      for (let i = 0; i < 4 && el && el !== document.body; i++, el = el.parentElement) {
        pointerClick(el);
        if (await waitForSpecificId(targetId, 1500)) return true;
      }
      return false;
    }
  }

  // ── Structure-based (WhatsApp / WEC) ─────────────────────────────────────

  // 1. Native click on inner navigation anchor (trusted, follows href).
  // Must be a[href*="selected_item_id"] — the Done/Follow-up buttons are also
  // <a> elements inside WEC rows and their React onClick fires on any .click(),
  // so a bare querySelector('a') would trigger Done. WEC navigation anchors
  // carry selected_item_id; action-button anchors end in '#' and don't.
  const innerAnchor = item.row.querySelector('a[href*="selected_item_id"]');
  if (innerAnchor && !isDangerousActionEl(innerAnchor)) {
    // If the anchor already points to the current conversation, no click needed.
    let innerAnchorId;
    try { innerAnchorId = new URL(innerAnchor.href).searchParams.get('selected_item_id'); } catch {}
    if (innerAnchorId && innerAnchorId === prevId) {
      item.realId = prevId;
      return true;
    }
    innerAnchor.click();
    const id = await waitForAnyIdChange(prevId, 2500);
    if (id) { item.realId = id; return true; }
  }

  // 2. Find conversation ID in data attributes → pushState navigation
  const dataId = getConvIdFromRow(item.row);
  if (dataId) {
    if (dataId === prevId) {
      // Data attribute confirms we're already at this conversation.
      item.realId = dataId;
      return true;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('selected_item_id', dataId);
    history.pushState({}, '', url.toString());
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    const id = await waitForAnyIdChange(prevId, 3000);
    if (id) { item.realId = id; return true; }
  }

  // 3. React fiber traversal on the row and its inner descendants.
  // Anchors (<a>) are intentionally excluded: in WEC rows the ONLY anchors are
  // the Done / Follow-up action buttons (a[role="row"]). Legitimate WEC
  // navigation is handled by React click handlers on div elements.
  const innerEls = [item.row, ...Array.from(item.row.querySelectorAll('div,li,span'))
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .slice(0, 12)];
  for (const el of innerEls) {
    if (isDangerousActionEl(el)) continue;
    if (reactClick(el)) {
      const id = await waitForAnyIdChange(prevId, 2000);
      if (id) { item.realId = id; return true; }
    }
  }

  // 4. Pointer+mouse sequence at a safe point in the LEFT quarter of the row
  // (avatar/name area). Action buttons are absolutely-positioned on the RIGHT
  // side and may appear in elementsFromPoint even at center, so we stay left.
  const rect = item.row.getBoundingClientRect();
  const cx = rect.left + rect.width * 0.25;  // 25% from left = avatar/name zone
  const cy = rect.top  + rect.height / 2;
  const inViewport = rect.width > 0 && rect.height > 0 &&
    cy >= 0 && cy <= window.innerHeight && cx >= 0 && cx <= window.innerWidth;
  if (inViewport) {
    const stack = (document.elementsFromPoint(cx, cy) || []).filter(
      e => e !== document.body && e !== document.documentElement && !isDangerousActionEl(e)
    );
    for (const el of stack) {
      if (reactClick(el)) {
        const id = await waitForAnyIdChange(prevId, 1200);
        if (id) { item.realId = id; return true; }
      }
      pointerClick(el);
      const id = await waitForAnyIdChange(prevId, 800);
      if (id) { item.realId = id; return true; }
    }
  }

  // 5. Row + ancestors
  let el = item.row;
  for (let i = 0; i < 4 && el && el !== document.body; i++, el = el.parentElement) {
    if (isDangerousActionEl(el)) continue;
    pointerClick(el);
    const id = await waitForAnyIdChange(prevId, 800);
    if (id) { item.realId = id; return true; }
  }

  // Final fallback: URL never changed — we're still at prevId.
  // The most common cause is that the first sidebar item is already the
  // active/open conversation. Treat as success: the thread is loaded and ready
  // to extract. If prevId was already downloaded, _seenIds catches the duplicate.
  const finalId = getSelectedItemId();
  if (finalId && finalId === prevId) {
    item.realId = finalId;
    return true;
  }

  return false;
}

/**
 * Safety check: return true if the current URL suggests a conversation was
 * moved to Done/archive. Stops the crawler immediately if detected.
 */
function checkForDoneTrigger(context) {
  const url = window.location.href.toLowerCase();
  if (/mailbox[_=]done|folder[=_]done|archive|folder=done/i.test(url)) {
    const msg = `⚠ DONE/ARCHIVE FOLDER DETECTED after ${context} — stopping crawler to prevent further moves. URL: ${window.location.href}`;
    console.error('[DM Extractor]', msg);
    log('err', msg);
    stopCrawler(); // halt immediately
    return true;
  }
  return false;
}

/**
 * Return true if `el` is a conversation-row action button (Done, Delete, Spam, Star…)
 * that must never be triggered by the crawler's click strategies.
 *
 * Three layers of defence:
 *   1. Self aria-label / title keyword match (catches gridcells directly).
 *   2. Ancestor check via closest() — catches anchor wrappers (a[role="row"])
 *      that sit inside the action grid but carry no aria-label themselves.
 *   3. Descendant check via querySelector — catches containers of dangerous
 *      gridcells even when the structural roles/classes change across deploys.
 */
function isDangerousActionEl(el) {
  const label = (el.getAttribute('aria-label') || '').toLowerCase();
  const title = (el.getAttribute('title') || '').toLowerCase();
  const combined = label + ' ' + title;
  if (/done|მზადაა|გადატანა|delete|spam|სპამი|star|flag|archive|mark as/i.test(combined)) return true;
  // Button/role="button" with short action-like text
  if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
    const text = (el.textContent || '').trim();
    if (text.length < 40 && /done|მზადაა|delete|spam|სპამი|star|flag/i.test(text)) return true;
  }
  // Ancestor check: inside the WEC action-buttons grid.
  try {
    if (el.closest('[role="grid"],[role="gridcell"]')) return true;
    if (el.closest('._4a51')) return true;
  } catch { }
  // Anchor-specific descendant check: WEC action buttons (Done / Follow-up)
  // are wrapped in <a role="row"> elements that contain gridcells but carry
  // no aria-label themselves. Block any <a> that has role="row" OR whose
  // subtree contains a gridcell / dangerous Georgian label.
  // Scoped to <a> only so the full row wrapper div is never falsely blocked.
  if (el.tagName === 'A') {
    if (el.getAttribute('role') === 'row') return true;
    try {
      if (el.querySelector('[role="gridcell"],[aria-label*="მზადაა"],[aria-label*="გადატანა"]')) return true;
    } catch { }
  }
  return false;
}

/**
 * Dispatch pointer+mouse down/up/click WITHOUT hover events.
 * Hover events (pointerover/mouseover/pointermove/mousemove) are intentionally
 * omitted: MBS reveals action buttons (Done, Delete, Spam) on hover, and
 * dispatching them caused those buttons to appear and get triggered by
 * subsequent click events.
 */
function pointerClick(el) {
  if (isDangerousActionEl(el)) return;
  const p = { bubbles: true, cancelable: true, view: window, isPrimary: true, button: 0, buttons: 1, pointerId: 1 };
  const m = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
  try {
    el.dispatchEvent(new PointerEvent('pointerdown',  p));
    el.dispatchEvent(new MouseEvent('mousedown',      m));
    el.dispatchEvent(new PointerEvent('pointerup',    p));
    el.dispatchEvent(new MouseEvent('mouseup',        m));
    el.dispatchEvent(new MouseEvent('click',          m));
  } catch { }
}

/**
 * Scan data attributes on `row` and its descendants for a numeric conversation ID.
 * Returns the ID string or null.
 */
function getConvIdFromRow(row) {
  const nodes = [row, ...row.querySelectorAll('[data-thread-id],[data-conversation-id],[data-item-id],[data-id]')];
  for (const el of nodes) {
    for (const attr of el.attributes) {
      if (/thread|conv|item|chat/i.test(attr.name) && /^\d{5,}$/.test(attr.value)) {
        return attr.value;
      }
    }
  }
  return null;
}

/**
 * Walk the React fiber tree upward from `el` and invoke the first found
 * onMouseDown / onClick / onPointerDown prop.
 * Returns true if a handler was found and called.
 */
function reactClick(el) {
  try {
    const key = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
    );
    if (!key) return false;
    let fiber = el[key];
    let depth = 0;
    while (fiber && depth < 20) {
      const props = fiber.memoizedProps;
      if (props) {
        // Skip if this fiber's aria-label or text looks like a Done/action button
        const label = (props['aria-label'] || props['title'] || '').toLowerCase();
        if (/done|მზადაა|delete|spam|სპამი|archive|mark as/i.test(label)) {
          fiber = fiber.return; depth++; continue;
        }
        for (const name of ['onMouseDown', 'onClick', 'onPointerDown']) {
          if (typeof props[name] === 'function') {
            const evt = new MouseEvent(
              name === 'onMouseDown' ? 'mousedown' : 'click',
              { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 }
            );
            props[name](evt);
            return true;
          }
        }
      }
      fiber = fiber.return;
      depth++;
    }
  } catch { }
  return false;
}

/** Resolves with the new selected_item_id when URL changes, or null on timeout. */
function waitForAnyIdChange(prevId, timeout) {
  return new Promise(resolve => {
    const cur = getSelectedItemId();
    if (cur && cur !== prevId) { resolve(cur); return; }
    const deadline = Date.now() + timeout;
    const iv = setInterval(() => {
      const id = getSelectedItemId();
      if (id && id !== prevId) { clearInterval(iv); resolve(id); }
      else if (Date.now() >= deadline) { clearInterval(iv); resolve(null); }
    }, 100);
  });
}

/** Resolves true when selected_item_id in URL matches targetId, false on timeout. */
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
 * Determine whether to include a conversation based on its last message date.
 * If the last parseable message date falls within [fromDate, toDate], return
 * ALL messages (full conversation context).  Otherwise return empty (skip it).
 *
 * "What matters is that the last message is inside the range."
 *
 * @param {Array} messages
 * @param {Date} fromDate
 * @param {Date} toDate
 * @returns {{ filtered: boolean, filteredMessages: Array }}
 */
function filterByDateRange(messages, fromDate, toDate) {
  if (!messages.length) return { filtered: false, filteredMessages: [], tooOld: false };

  // Find the last message that carries a parseable date label
  let lastDate = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const d = parseDateLabel(messages[i].date);
    if (d) { lastDate = d; break; }
  }

  // If no date is parseable, include conservatively (can't tell → don't skip)
  if (!lastDate || dateInRange(lastDate, fromDate, toDate)) {
    return { filtered: false, filteredMessages: messages, tooOld: false };
  }

  // Last message is outside the range → skip this conversation entirely.
  // tooOld=true signals the crawler to stop early (conversations are newest-first).
  const tooOld = lastDate < fromDate;
  return { filtered: true, filteredMessages: [], tooOld };
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
