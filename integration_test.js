/**
 * integration_test.js
 * Uses Chrome for Testing (Linux build, supports --load-extension) via puppeteer
 * to load the DM Extractor extension against a mock WEC inbox page and verify
 * that Strategy C row detection and structural message extraction work correctly.
 *
 * Chrome binary: ~/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome
 * Required LD_LIBRARY_PATH: /tmp/chrome-libs/usr/lib/x86_64-linux-gnu
 */
'use strict';

const puppeteer = require('puppeteer');
const http      = require('http');
const fs        = require('fs');
const path      = require('path');

const EXT_DIR = path.resolve(__dirname);
const PORT    = 18765;

// ─── Mock WEC inbox page ─────────────────────────────────────────────────────
const MOCK_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>Inbox · WhatsApp</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{display:flex;width:1280px;height:800px;background:#f0f2f5;font-family:Arial,sans-serif}
#sidebar{width:360px;height:800px;overflow:auto;background:#fff;border-right:1px solid #d9dbdf}
.conv-row{display:flex;align-items:center;height:72px;padding:8px 16px;border-bottom:1px solid #f0f2f5;cursor:pointer}
.conv-row:hover{background:#f5f6f7}
.conv-avatar{width:46px;height:46px;border-radius:50%;background:#ccc;flex-shrink:0;margin-right:12px}
.conv-text{flex:1;overflow:hidden}
.conv-name{font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.conv-preview{font-size:13px;color:#65676b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#thread{flex:1;height:800px;display:flex;flex-direction:column}
#thread-header{height:60px;background:#fff;border-bottom:1px solid #d9dbdf;padding:12px 16px;display:flex;align-items:center}
#message-list-container{flex:1;overflow:auto;padding:16px;background:#e5ddd5}
.msg-wrap{margin:4px 0;display:flex}
.msg-wrap.out{justify-content:flex-end}
.msg-wrap.in{justify-content:flex-start}
.bubble{max-width:60%;background:#fff;border-radius:8px;padding:8px 12px;font-size:14px;line-height:1.4}
.msg-wrap.out .bubble{background:#dcf8c6}
</style></head>
<body>

<div id="sidebar">
  <div class="conv-row" onclick="openConv(1)">
    <div class="conv-avatar"></div>
    <div class="conv-text">
      <div class="conv-name">Nino Beridze</div>
      <div class="conv-preview">გამარჯობა, შეკვეთა მოვიდა?</div>
    </div>
  </div>
  <div class="conv-row" onclick="openConv(2)">
    <div class="conv-avatar"></div>
    <div class="conv-text">
      <div class="conv-name">Giorgi Kvaratskhelia</div>
      <div class="conv-preview">Hello, what is the delivery time?</div>
    </div>
  </div>
  <div class="conv-row" onclick="openConv(3)">
    <div class="conv-avatar"></div>
    <div class="conv-text">
      <div class="conv-name">Ana Lomidze</div>
      <div class="conv-preview">when will my order arrive?</div>
    </div>
  </div>
</div>

<div id="thread">
  <div id="thread-header"><strong id="conv-title">Nino Beridze</strong></div>
  <div id="message-list-container"
       aria-label="Message list container"
       role="list">
    <div class="msg-wrap in">
      <div class="bubble"><div dir="auto">გამარჯობა, შეკვეთა მოვიდა?</div></div>
    </div>
    <div class="msg-wrap out">
      <div class="bubble"><div dir="auto">გამარჯობა! შეკვეთა 3-5 სამუშაო დღეში მოვა.</div></div>
    </div>
    <div class="msg-wrap in">
      <div class="bubble"><div dir="auto">გმადლობთ ინფორმაციისთვის!</div></div>
    </div>
  </div>
</div>

<script>
function openConv(id) {
  var url = new URL(window.location.href);
  url.searchParams.set('selected_item_id', id);
  history.pushState({}, '', url.toString());
  document.getElementById('conv-title').textContent =
    ['','Nino Beridze','Giorgi Kvaratskhelia','Ana Lomidze'][id];
}
window.addEventListener('load', function() { openConv(1); });
</script>
</body></html>`;

// ─── Temporarily patch manifest to allow localhost ────────────────────────────
const MANIFEST_PATH = path.join(EXT_DIR, 'manifest.json');
const origManifest  = fs.readFileSync(MANIFEST_PATH, 'utf8');
const manifest      = JSON.parse(origManifest);
manifest.content_scripts[0].matches.push('http://localhost/*');
manifest.web_accessible_resources[0].matches.push('http://localhost/*');
fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(MOCK_HTML);
});

async function main() {
  await new Promise(r => server.listen(PORT, 'localhost', r));
  console.log(`Mock WEC page: http://localhost:${PORT}/`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: path.join(process.env.HOME, '.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome'),
      headless: true,
      args: [
        `--load-extension=${EXT_DIR}`,
        `--disable-extensions-except=${EXT_DIR}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-crash-reporter',
        '--no-crashpad',
        '--disable-gpu',
        `--user-data-dir=/tmp/dm-ext-test-${Date.now()}`,
        '--no-first-run',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `/tmp/chrome-libs/usr/lib/x86_64-linux-gnu:${process.env.LD_LIBRARY_PATH || ''}`,
        BREAKPAD_DISABLED: '1',
      },
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const extLogs = [];
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('DM Extractor') || text.includes('Extractor') || text.includes('Strategy')) {
        extLogs.push(text);
        console.log('[ext]', text);
      }
    });

    console.log(`Navigating to mock WEC page...`);
    await page.goto(`http://localhost:${PORT}/?selected_item_id=1`, {
      waitUntil: 'networkidle0',
      timeout: 15000,
    });

    // Wait for content script to inject
    await new Promise(r => setTimeout(r, 2000));

    // ── Test 1: Extension panel injected ─────────────────────────────────────
    const panelExists = await page.evaluate(() => !!document.getElementById('dm-extractor-host'));
    console.log(`Extension panel injected: ${panelExists}`);
    if (!panelExists) {
      console.log('✗ Panel not found — content script may not have run');
      process.exitCode = 1;
    }

    // ── Test 2: Strategy C row detection ─────────────────────────────────────
    console.log('\n=== Test: Strategy C row detection ===');
    const rows = await page.evaluate(() => {
      const sidebar = document.getElementById('sidebar');
      if (!sidebar) return { error: 'no sidebar' };
      const half = window.innerWidth / 2;
      const allEls = Array.from(sidebar.querySelectorAll('*'));
      const cands = allEls.filter(el => {
        const r = el.getBoundingClientRect();
        if (!(r.height >= 50 && r.height <= 220 && r.width > 100 && r.left < half && r.left >= 0)) return false;
        const text = el.textContent.replace(/\s+/g, ' ').trim();
        return text.length >= 4 && text.length <= 400 && !/^[.…]+$/.test(text);
      });
      const outer = cands.filter(el => !cands.some(o => o !== el && o.contains(el)));
      return outer.map(r => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
    });
    console.log('Rows:', JSON.stringify(rows));
    const rowOk = Array.isArray(rows) && rows.length >= 2;
    console.log(rowOk ? `✓ Strategy C: ${rows.length} rows found` : '✗ Strategy C failed');
    if (!rowOk) process.exitCode = 1;

    // ── Test 3: Structural message extraction ─────────────────────────────────
    console.log('\n=== Test: Structural message extraction ===');
    const msgs = await page.evaluate(() => {
      const region = document.querySelector('[aria-label*="Message list container"]');
      if (!region) return { error: 'no region' };
      const regionRect = region.getBoundingClientRect();
      const result = [];
      const seen = new Set();
      for (const el of region.querySelectorAll('[dir="auto"]')) {
        if (el.closest('[aria-hidden="true"]') || el.closest('[role="button"]')) continue;
        const text = el.textContent.trim();
        if (!text) continue;
        const r = el.getBoundingClientRect();
        if (r.height < 5 || r.width < 5) continue;
        const key = `${Math.round(r.top/5)}_${text.slice(0,40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const mid = (r.left + r.width / 2 - regionRect.left) / regionRect.width;
        const dir = mid > 0.55 ? 'outbound' : mid < 0.45 ? 'inbound' : 'unknown';
        result.push({ dir, text: text.slice(0, 60) });
      }
      return result;
    });
    console.log('Messages:', JSON.stringify(msgs));
    const msgOk = Array.isArray(msgs) && msgs.length >= 2;
    console.log(msgOk ? `✓ Structural fallback: ${msgs.length} messages` : '✗ Structural fallback failed');
    if (!msgOk) process.exitCode = 1;

    // ── Test 4: window.__obsidiaExtract ───────────────────────────────────────
    if (panelExists) {
      console.log('\n=== Test: window.__obsidiaExtract() ===');
      const result = await page.evaluate(async () => {
        if (typeof window.__obsidiaExtract !== 'function')
          return { error: '__obsidiaExtract not found' };
        return window.__obsidiaExtract();
      });
      console.log('Extract result:', JSON.stringify(result));
      if (result && !result.error && result.count > 0) {
        console.log(`✓ __obsidiaExtract: ${result.count} messages from "${result.thread}"`);
      } else {
        console.log('⚠ __obsidiaExtract:', result?.error || JSON.stringify(result));
      }
    }

    if (extLogs.length) {
      console.log('\n=== Extension logs ===');
      extLogs.forEach(l => console.log(' ', l));
    }

    console.log(process.exitCode ? '\n✗ SOME TESTS FAILED' : '\n✓ ALL TESTS PASSED');

  } finally {
    if (browser) await browser.close();
    server.close();
    fs.writeFileSync(MANIFEST_PATH, origManifest);
    console.log('Manifest restored.');
  }
}

main().catch(err => {
  fs.writeFileSync(MANIFEST_PATH, origManifest);
  console.error('Fatal:', err.message);
  process.exit(1);
});
