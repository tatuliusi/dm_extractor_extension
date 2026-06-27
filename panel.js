/**
 * panel.js — UI controller for the DM Extractor floating panel.
 *
 * Execution context: injected via <script> tag into the Shadow DOM document.
 * Cannot use ES module syntax. Communicates with content.js exclusively
 * through the shared `window.__dmExtractor` object which content.js creates
 * before injecting this script.
 */

'use strict';

(function () {
  // ─── Bridge to content.js ───────────────────────────────────────────────
  // content.js sets window.__dmExtractor before injecting this script.
  // All crawler control goes through this bridge.
  const bridge = window.__dmExtractor;
  if (!bridge) {
    console.error('[DM Extractor] panel.js: bridge not found on window.__dmExtractor');
    return;
  }

  // ─── Element refs ────────────────────────────────────────────────────────
  const panel        = document.getElementById('dm-panel');
  const collapseBtn  = document.getElementById('dm-collapse-btn');
  const fromInput    = document.getElementById('dm-from');
  const toInput      = document.getElementById('dm-to');
  const startBtn     = document.getElementById('dm-start-btn');
  const pauseBtn     = document.getElementById('dm-pause-btn');
  const stopBtn      = document.getElementById('dm-stop-btn');
  const progressBar  = document.getElementById('dm-progress-bar');
  const statusInbox  = document.getElementById('dm-status-inbox');
  const statusConv   = document.getElementById('dm-status-conv');
  const countDl      = document.getElementById('dm-count-dl');
  const countSkip    = document.getElementById('dm-count-skip');
  const countErr     = document.getElementById('dm-count-err');
  const log          = document.getElementById('dm-log');

  // ─── Default date range (current calendar month) ─────────────────────────
  // toISOString() would give UTC dates which are wrong for UTC+ users (e.g.
  // Georgia UTC+4: local midnight = previous day in UTC → wrong default shown).
  // Use local date components instead.
  function localDateStr(d) {
    const pad = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  const now   = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  fromInput.value = localDateStr(first);
  toInput.value   = localDateStr(now);

  // ─── Collapse / expand ───────────────────────────────────────────────────
  collapseBtn.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    collapseBtn.textContent = panel.classList.contains('collapsed') ? '▸' : '▾';
  });

  // ─── Drag to reposition ──────────────────────────────────────────────────
  let dragging = false, dragOffX = 0, dragOffY = 0;

  document.getElementById('dm-header').addEventListener('mousedown', e => {
    dragging  = true;
    const rect = panel.getBoundingClientRect();
    dragOffX  = e.clientX - rect.left;
    dragOffY  = e.clientY - rect.top;
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

  // ─── Button handlers ─────────────────────────────────────────────────────

  startBtn.addEventListener('click', () => {
    const from = fromInput.value;
    const to   = toInput.value;

    if (!from || !to) {
      appendLog('Please set both From and To dates.', 'err');
      return;
    }
    if (from > to) {
      appendLog('"From" date must be before "To" date.', 'err');
      return;
    }

    setButtons('running');
    bridge.start({ from, to });
  });

  pauseBtn.addEventListener('click', () => {
    if (bridge.state() === 'paused') {
      setButtons('running');
      bridge.resume();
    } else {
      setButtons('paused');
      bridge.pause();
      pauseBtn.textContent = '▶ Resume';
    }
  });

  stopBtn.addEventListener('click', () => {
    bridge.stop();
    setButtons('idle');
  });

  // ─── Bridge callbacks (called by content.js) ─────────────────────────────

  bridge.onProgress = function (info) {
    // info: { inbox, convIndex, convTotal, downloaded, skipped, errors, convName }
    statusInbox.innerHTML = 'Inbox: <span class="dm-inbox-label">' +
      escHtml(info.inbox || '—') + '</span>';

    if (info.convTotal > 0) {
      statusConv.textContent =
        `Conversation: ${info.convIndex} / ${info.convTotal}` +
        (info.convName ? ` — ${truncate(info.convName, 24)}` : '');
      const pct = Math.round((info.convIndex / info.convTotal) * 100);
      progressBar.style.width = pct + '%';
    } else {
      statusConv.textContent = 'Scanning conversations…';
    }

    countDl.textContent   = 'Downloaded: ' + (info.downloaded || 0);
    countSkip.textContent = 'Skipped: '    + (info.skipped    || 0);
    countErr.textContent  = 'Errors: '     + (info.errors     || 0);
  };

  bridge.onLog = function (message, type) {
    // type: 'ok' | 'skip' | 'err' | 'info'
    appendLog(message, type || 'info');
  };

  bridge.onDone = function (summary) {
    setButtons('idle');
    progressBar.style.width = '100%';
    appendLog(
      `Done. Downloaded: ${summary.downloaded}  Skipped: ${summary.skipped}  Errors: ${summary.errors}`,
      'ok'
    );
  };

  // ─── Internal helpers ─────────────────────────────────────────────────────

  function setButtons(state) {
    if (state === 'idle') {
      startBtn.disabled = false;
      pauseBtn.disabled = true;
      stopBtn.disabled  = true;
      pauseBtn.textContent = '⏸ Pause';
      fromInput.disabled = false;
      toInput.disabled   = false;
    } else if (state === 'running') {
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      stopBtn.disabled  = false;
      pauseBtn.textContent = '⏸ Pause';
      fromInput.disabled = true;
      toInput.disabled   = true;
    } else if (state === 'paused') {
      startBtn.disabled = true;
      pauseBtn.disabled = false;
      stopBtn.disabled  = false;
      pauseBtn.textContent = '▶ Resume';
    }
  }

  function appendLog(message, type) {
    const line = document.createElement('div');
    line.className = 'log-' + (type || 'info');
    line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    log.appendChild(line);
    // Keep last 60 lines to avoid DOM bloat
    while (log.children.length > 60) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  function escHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function truncate(str, n) {
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  // Expose appendLog so content.js can also write to the log directly
  bridge.appendLog = appendLog;

})();
