/**
 * test_bubble_split.js
 * Verifies that splitIntoBubbles() breaks a data-message-id container that
 * groups multiple same-sender bubbles back into individual message entries.
 *
 * Mirrors the code in content.js so we can run it under Node/jsdom without
 * loading the extension.
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

// ─── bubbleText + splitIntoBubbles: exact copies from content.js ─────────────

function containsEmoji(text) {
  if (!text) return false;
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{2700}-\u{27BF}]/u.test(text);
}

function bubbleText(bubble) {
  const clone = bubble.cloneNode(true);
  const doc = clone.ownerDocument || bubble.ownerDocument;
  clone.querySelectorAll('img').forEach(img => {
    const alt = img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title') || '';
    if (alt) img.replaceWith(doc.createTextNode(alt));
  });
  clone.querySelectorAll('[role="img"]').forEach(el => {
    if (el.textContent.trim()) return;
    const label = el.getAttribute('aria-label') || '';
    if (label) el.replaceWith(doc.createTextNode(label));
  });
  clone.querySelectorAll(
    '[aria-hidden="true"], .sr-only, [style*="display:none"], [style*="display: none"]'
  ).forEach(n => {
    if (containsEmoji(n.textContent)) return;
    n.remove();
  });
  return clone.textContent.trim();
}

function splitIntoBubbles(node) {
  const RECEIPT_ONLY = /^(?:\d{1,2}:\d{2}(?:\s*(?:am|pm))?|seen|delivered|sent|read)$/i;

  const wrappers = Array.from(node.querySelectorAll('.x1nhvcw1, .x13a6bvl'));
  const outerWrappers = wrappers.filter(w =>
    !wrappers.some(other => other !== w && other.contains(w))
  );
  if (outerWrappers.length >= 2) {
    const bubbles = [];
    const seenTexts = new Set();
    for (const w of outerWrappers) {
      const text = bubbleText(w);
      if (!text) continue;
      if (seenTexts.has(text)) continue;
      seenTexts.add(text);
      const direction = w.classList.contains('x1nhvcw1') ? 'inbound' :
                        w.classList.contains('x13a6bvl') ? 'outbound' : null;
      bubbles.push({ text, direction, node: w });
    }
    if (bubbles.length >= 2) return bubbles;
  }

  const searchRoot = outerWrappers.length === 1 ? outerWrappers[0] : node;
  const singleWrapperDir = outerWrappers.length === 1
    ? (outerWrappers[0].classList.contains('x1nhvcw1') ? 'inbound' :
       outerWrappers[0].classList.contains('x13a6bvl') ? 'outbound' : null)
    : null;

  const dirAutoNodes = Array.from(searchRoot.querySelectorAll('[dir="auto"]'))
    .filter(el => !el.closest('[aria-hidden="true"]'))
    .filter(el => !el.closest('[role="button"]'))
    .filter(el => !el.closest('[data-testid="message_delivery_receipt"]'));
  const leafDirAuto = dirAutoNodes.filter(el =>
    !dirAutoNodes.some(other => other !== el && el.contains(other))
  );
  if (leafDirAuto.length >= 2) {
    const bubbles = [];
    const seenTexts = new Set();
    for (const el of leafDirAuto) {
      const text = bubbleText(el);
      if (!text) continue;
      if (text.length <= 12 && RECEIPT_ONLY.test(text)) continue;
      if (seenTexts.has(text)) continue;
      seenTexts.add(text);
      bubbles.push({ text, direction: singleWrapperDir, node: el });
    }
    if (bubbles.length >= 2) return bubbles;
  }

  return [];
}

// ─── Test 1: three inbound bubbles wrapped in .x1nhvcw1 direction wrappers ───
console.log('\n=== Test 1: three inbound bubbles under one data-message-id (direction wrappers) ===');
{
  const dom = new JSDOM(`
    <div id="group" data-message-id="group_abc">
      <div class="x1nhvcw1"><div dir="auto">კარგით, დავჯავშნი მაშინ 3 ივლისიდან</div></div>
      <div class="x1nhvcw1"><div dir="auto">მატ პილატესი</div></div>
      <div class="x1nhvcw1"><div dir="auto">ორშაბათი  ოთხშაბათი პარასკევი</div></div>
    </div>
  `);
  const node = dom.window.document.getElementById('group');
  const bubbles = splitIntoBubbles(node);
  assert(bubbles.length === 3, `expected 3 bubbles, got ${bubbles.length}`);
  assert(bubbles[0] && bubbles[0].text === 'კარგით, დავჯავშნი მაშინ 3 ივლისიდან', 'bubble 0 text preserved');
  assert(bubbles[1] && bubbles[1].text === 'მატ პილატესი', 'bubble 1 text preserved');
  assert(bubbles[2] && bubbles[2].text === 'ორშაბათი  ოთხშაბათი პარასკევი', 'bubble 2 text preserved');
  assert(bubbles.every(b => b.direction === 'inbound'), 'all bubbles marked inbound from wrapper class');
}

// ─── Test 2: single bubble — must NOT split ──────────────────────────────────
console.log('\n=== Test 2: single bubble stays intact ===');
{
  const dom = new JSDOM(`
    <div id="single" data-message-id="msg1">
      <div class="x1nhvcw1"><div dir="auto">გამარჯობა</div></div>
    </div>
  `);
  const node = dom.window.document.getElementById('single');
  const bubbles = splitIntoBubbles(node);
  assert(bubbles.length === 0, `single bubble should not split (got ${bubbles.length})`);
}

// ─── Test 3: bubble with adjacent timestamp — must NOT split ─────────────────
console.log('\n=== Test 3: bubble + timestamp dir="auto" sibling does not split ===');
{
  const dom = new JSDOM(`
    <div id="withts" data-message-id="msg2">
      <div dir="auto">Hello there</div>
      <div dir="auto">3:45 PM</div>
    </div>
  `);
  const node = dom.window.document.getElementById('withts');
  const bubbles = splitIntoBubbles(node);
  assert(bubbles.length === 0, `bubble+timestamp should not split (got ${bubbles.length})`);
}

// ─── Test 4: outbound direction wrappers detected ────────────────────────────
console.log('\n=== Test 4: outbound direction wrappers produce outbound entries ===');
{
  const dom = new JSDOM(`
    <div id="out" data-message-id="out1">
      <div class="x13a6bvl"><div dir="auto">Sure thing</div></div>
      <div class="x13a6bvl"><div dir="auto">Talk soon</div></div>
    </div>
  `);
  const node = dom.window.document.getElementById('out');
  const bubbles = splitIntoBubbles(node);
  assert(bubbles.length === 2, `expected 2 outbound bubbles, got ${bubbles.length}`);
  assert(bubbles.every(b => b.direction === 'outbound'), 'both bubbles marked outbound');
}

// ─��─ Test 5: dir="auto" fallback splits when no direction classes ────────────
console.log('\n=== Test 5: dir="auto" fallback split when no direction wrappers ===');
{
  const dom = new JSDOM(`
    <div id="fb" data-message-id="fb1">
      <div dir="auto">First line as its own bubble</div>
      <div dir="auto">Second line as its own bubble</div>
    </div>
  `);
  const node = dom.window.document.getElementById('fb');
  const bubbles = splitIntoBubbles(node);
  assert(bubbles.length === 2, `dir=auto fallback should yield 2 bubbles, got ${bubbles.length}`);
}

// ─── Test 5b: single direction wrapper with multiple dir="auto" children ────
console.log('\n=== Test 5b: single .x13a6bvl wrapper with multiple dir="auto" sub-bubbles ===');
{
  const dom = new JSDOM(`
    <div id="grouped" data-message-id="grouped1">
      <div class="x13a6bvl">
        <div dir="auto">First sent message</div>
        <div dir="auto">Second sent message</div>
        <div dir="auto">Third sent message</div>
      </div>
    </div>
  `);
  const node = dom.window.document.getElementById('grouped');
  const bubbles = splitIntoBubbles(node);
  assert(bubbles.length === 3, `expected 3 bubbles from single wrapper, got ${bubbles.length}`);
  assert(bubbles[0] && bubbles[0].text === 'First sent message', 'bubble 0 text');
  assert(bubbles[1] && bubbles[1].text === 'Second sent message', 'bubble 1 text');
  assert(bubbles[2] && bubbles[2].text === 'Third sent message', 'bubble 2 text');
  assert(bubbles.every(b => b.direction === 'outbound'), 'all bubbles inherit outbound direction');
}

// ─── Test 5c: single .x1nhvcw1 wrapper with nested dir="auto" hierarchy ─────
console.log('\n=== Test 5c: single .x1nhvcw1 wrapper with nested dir="auto" (outer contains inner) ===');
{
  const dom = new JSDOM(`
    <div id="nested" data-message-id="nested1">
      <div class="x1nhvcw1">
        <div dir="auto">
          <div dir="auto">Nested message one</div>
          <div dir="auto">Nested message two</div>
        </div>
      </div>
    </div>
  `);
  const node = dom.window.document.getElementById('nested');
  const bubbles = splitIntoBubbles(node);
  assert(bubbles.length === 2, `expected 2 inner bubbles from nested structure, got ${bubbles.length}`);
  assert(bubbles.every(b => b.direction === 'inbound'), 'all bubbles inherit inbound direction');
}

// ─── Test 6: text with newlines/paragraphs in ONE dir="auto" stays merged ────
console.log('\n=== Test 6: multi-line single bubble stays as one ===');
{
  const dom = new JSDOM(`
    <div id="ml" data-message-id="ml1">
      <div class="x1nhvcw1"><div dir="auto">line one<br>line two<br>line three</div></div>
    </div>
  `);
  const node = dom.window.document.getElementById('ml');
  const bubbles = splitIntoBubbles(node);
  assert(bubbles.length === 0, `multi-line single bubble should not split (got ${bubbles.length})`);
}

// ─── Walker guardrails: mock the extract() walker's system-event branch ────
// Verifies that a role="status" wrapper enclosing real message-id bubbles
// falls through to the message-bubble branch (where splitIntoBubbles runs)
// instead of being swallowed into one merged sys_ entry.

function runWalker(region) {
  const messages = [];
  const seenMsgIds = new Set();
  const walker = region.ownerDocument.createTreeWalker(region, 1 /* SHOW_ELEMENT */);
  let node;
  while ((node = walker.nextNode())) {
    // Skip the region itself
    if (node === region) continue;

    // System-event guardrail (mirrors content.js)
    const role = node.getAttribute('role');
    const testId = (node.getAttribute('data-testid') || '').toLowerCase();
    const looksLikeSystem =
      role === 'note' || role === 'status' ||
      testId.includes('activity') || testId.includes('event_log') || testId.includes('assignment');
    if (looksLikeSystem) {
      const selfHasMsgId =
        node.hasAttribute('data-message-id') ||
        node.hasAttribute('data-mid') ||
        node.hasAttribute('data-msgid') ||
        node.hasAttribute('data-focusable-id') ||
        node.hasAttribute('data-item-id');
      const wrapsRealMessages = selfHasMsgId || !!node.querySelector(
        '[data-message-id],[data-mid],[data-msgid],[data-focusable-id],[data-item-id]'
      );
      if (!wrapsRealMessages) {
        const text = bubbleText(node);
        if (text && text.length <= 240) {
          const dedupeKey = 'sys:' + text.slice(0, 80);
          if (!seenMsgIds.has(dedupeKey)) {
            seenMsgIds.add(dedupeKey);
            messages.push({ id: 'sys_' + messages.length, type: 'system_event', text });
          }
          continue;
        }
      }
    }

    // Message-bubble branch
    const primaryId = node.getAttribute('data-message-id') ||
                      node.getAttribute('data-mid') ||
                      node.getAttribute('data-msgid');
    const groupId = node.getAttribute('data-focusable-id') ||
                    node.getAttribute('data-item-id');
    const msgId = primaryId || groupId;
    if (!msgId) continue;
    if (!primaryId && groupId) {
      const hasMessageChildren = node.querySelector('[data-message-id],[data-mid],[data-msgid]');
      if (hasMessageChildren) continue;
    }
    if (seenMsgIds.has(msgId)) continue;
    seenMsgIds.add(msgId);

    const hasInnerMessageIds = !!node.querySelector('[data-message-id],[data-mid],[data-msgid]');
    const subBubbles = hasInnerMessageIds ? [] : splitIntoBubbles(node);
    if (subBubbles.length >= 2) {
      subBubbles.forEach((sub, i) => {
        if (sub.node && sub.node.getAttribute) {
          const innerId = sub.node.getAttribute('data-message-id') ||
                          sub.node.getAttribute('data-mid') ||
                          sub.node.getAttribute('data-msgid');
          if (innerId) seenMsgIds.add(innerId);
        }
        messages.push({ id: `${msgId}#${i}`, type: 'text', text: sub.text });
      });
      continue;
    }

    const text = bubbleText(node);
    if (!text) continue;
    messages.push({ id: msgId, type: 'text', text });
  }
  return messages;
}

// ─── Test 7: role="status" wrapper enclosing bubbles must fall through ──────
console.log('\n=== Test 7: role="status" wrapper does not swallow real bubbles ===');
{
  const dom = new JSDOM(`
    <div id="region">
      <div role="status" data-message-id="group_xyz">
        <div class="x1nhvcw1"><div dir="auto">კარგით, დავჯავშნი მაშინ 3 ივლისიდან</div></div>
        <div class="x1nhvcw1"><div dir="auto">მატ პილატესი</div></div>
        <div class="x1nhvcw1"><div dir="auto">ორშაბათი  ოთხშაბათი პარასკევი</div></div>
      </div>
    </div>
  `);
  const region = dom.window.document.getElementById('region');
  const msgs = runWalker(region);
  assert(msgs.length === 3, `expected 3 text entries after guardrail, got ${msgs.length}`);
  assert(msgs.every(m => m.type === 'text'), 'all entries emitted as text (not system_event)');
  assert(msgs[0] && msgs[0].text === 'კარგით, დავჯავშნი მაშინ 3 ივლისიდან', 'entry 0 text preserved');
  assert(msgs[1] && msgs[1].text === 'მატ პილატესი', 'entry 1 text preserved');
  assert(msgs[2] && msgs[2].text === 'ორშაბათი  ოთხშაბათი პარასკევი', 'entry 2 text preserved');
}

// ─── Test 8: role="status" wrapper WITHOUT inner IDs still emits system ─────
console.log('\n=== Test 8: real role="status" activity note still captured as system ===');
{
  const dom = new JSDOM(`
    <div id="region2">
      <div role="status">John was assigned to this conversation</div>
    </div>
  `);
  const region = dom.window.document.getElementById('region2');
  const msgs = runWalker(region);
  assert(msgs.length === 1, `expected 1 system entry, got ${msgs.length}`);
  assert(msgs[0] && msgs[0].type === 'system_event', 'entry emitted as system_event');
}

// ─── Test 9: role="status" wrapper with overlong text is NOT a system event ─
console.log('\n=== Test 9: role="status" wrapper with overlong text falls through ===');
{
  const longText = 'a'.repeat(300);
  const dom = new JSDOM(`
    <div id="region3">
      <div role="status" data-message-id="long1">${longText}</div>
    </div>
  `);
  const region = dom.window.document.getElementById('region3');
  const msgs = runWalker(region);
  // Long text with a data-message-id but no sub-bubbles: falls through and
  // gets captured as a single text message (not a system_event).
  assert(msgs.length === 1, `expected 1 entry, got ${msgs.length}`);
  assert(msgs[0] && msgs[0].type === 'text', `overlong content should not be system_event, got ${msgs[0] && msgs[0].type}`);
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
