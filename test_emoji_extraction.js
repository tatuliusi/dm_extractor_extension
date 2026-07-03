/**
 * test_emoji_extraction.js
 * Verifies that bubbleText() correctly extracts emojis and stickers from the
 * three Meta DM surfaces: Instagram, Facebook Messenger, and WhatsApp Business.
 *
 * bubbleText originally used textContent, which silently drops <img alt="😊">
 * — the shape Meta uses for emoji sprites and stickers. This test locks in the
 * fix so emojis show up in downloaded conversations.
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

// ─── Inline copies of the containsEmoji + bubbleText functions from content.js ─
// (kept in sync manually with content.js so tests run in Node without a browser)

function containsEmoji(text) {
  if (!text) return false;
  return /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{2700}-\u{27BF}]/u.test(text);
}

function bubbleText(bubble) {
  const clone = bubble.cloneNode(true);
  const doc = clone.ownerDocument || bubble.ownerDocument;

  clone.querySelectorAll('img').forEach(img => {
    const alt = img.getAttribute('alt')
             || img.getAttribute('aria-label')
             || img.getAttribute('title')
             || '';
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

// ─── Test 1: containsEmoji helper ────────────────────────────────────────────

console.log('\n=== Test: containsEmoji helper ===');
assert(containsEmoji('😊') === true, 'plain emoji detected');
assert(containsEmoji('hello 🎉 world') === true, 'emoji mixed with text detected');
assert(containsEmoji('🇺🇸') === true, 'regional-indicator flag detected');
assert(containsEmoji('👨‍👩‍👧') === true, 'ZWJ compound emoji detected');
assert(containsEmoji('hello world') === false, 'plain ascii is not an emoji');
assert(containsEmoji('') === false, 'empty string is not an emoji');
assert(containsEmoji('გამარჯობა') === false, 'Georgian text is not an emoji');
assert(containsEmoji('❤') === true, 'BMP heart symbol detected');

// ─── Test 2: Facebook Messenger — <img alt="😊"> at top level ────────────────

console.log('\n=== Test: Facebook Messenger emoji <img alt> ===');

const fbDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div data-message-id="fb1" class="bubble">
    <span dir="auto">Nice photo </span><img alt="😊" src="/emoji.png" class="_1ift">
  </div>
  <div data-message-id="fb2" class="bubble">
    <img alt="🎉" src="/emoji.png"><img alt="🎉" src="/emoji.png">
  </div>
</body></html>`);

const fbBubble1 = fbDom.window.document.querySelector('[data-message-id="fb1"]');
const fbText1 = bubbleText(fbBubble1);
assert(fbText1.includes('😊'), `mixed text + emoji: got "${fbText1}"`);
assert(fbText1.includes('Nice photo'), 'surrounding text preserved');

const fbBubble2 = fbDom.window.document.querySelector('[data-message-id="fb2"]');
const fbText2 = bubbleText(fbBubble2);
assert(fbText2 === '🎉🎉', `emoji-only message: got "${fbText2}"`);

// ─── Test 3: WhatsApp Business — <img alt> inside dir="auto" wrapper ─────────

console.log('\n=== Test: WhatsApp Business (WEC) emoji <img alt> ===');

const waDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="bubble">
    <div dir="auto"><img alt="👍" src="/e.png"></div>
  </div>
  <div class="bubble2">
    <div dir="auto">გამარჯობა <img alt="🙏" src="/e.png"></div>
  </div>
</body></html>`);

const waBubble1 = waDom.window.document.querySelector('.bubble');
const waText1 = bubbleText(waBubble1);
assert(waText1 === '👍', `WEC emoji-only message: got "${waText1}"`);

const waBubble2 = waDom.window.document.querySelector('.bubble2');
const waText2 = bubbleText(waBubble2);
assert(waText2.includes('🙏'), `WEC Georgian + emoji: got "${waText2}"`);
assert(waText2.includes('გამარჯობა'), 'WEC Georgian text preserved');

// ─── Test 4: Sprite pattern — emoji unicode inside aria-hidden span ──────────

console.log('\n=== Test: sprite emoji with unicode inside aria-hidden ===');

const spriteDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="bubble">
    <span dir="auto">Reply: </span>
    <span role="img" aria-label="smiling face">
      <span aria-hidden="true" style="background-image:url(emoji-sprite.png)">😀</span>
    </span>
  </div>
</body></html>`);

const spriteBubble = spriteDom.window.document.querySelector('.bubble');
const spriteText = bubbleText(spriteBubble);
assert(spriteText.includes('😀'), `sprite emoji unicode preserved: got "${spriteText}"`);
assert(spriteText.includes('Reply:'), 'surrounding text preserved');
// The aria-label description should NOT be duplicated when the emoji unicode is already present
assert(!spriteText.includes('smiling face'), 'aria-label description not duplicated when unicode is present');

// ─── Test 5: role="img" with aria-label only (no inner text) ─────────────────

console.log('\n=== Test: role="img" with aria-label only ===');

const roleDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="bubble">
    <span>Hey </span><span role="img" aria-label="🎉"></span>
  </div>
</body></html>`);

const roleBubble = roleDom.window.document.querySelector('.bubble');
const roleText = bubbleText(roleBubble);
assert(roleText.includes('🎉'), `role="img" aria-label materialised: got "${roleText}"`);

// ─── Test 6: Non-emoji aria-hidden nodes are still stripped ──────────────────

console.log('\n=== Test: aria-hidden without emoji is still stripped ===');

const hiddenDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="bubble">
    <span dir="auto">Visible text</span>
    <span aria-hidden="true">screen reader duplicate</span>
  </div>
</body></html>`);

const hiddenBubble = hiddenDom.window.document.querySelector('.bubble');
const hiddenText = bubbleText(hiddenBubble);
assert(hiddenText === 'Visible text', `non-emoji aria-hidden stripped: got "${hiddenText}"`);

// ─── Test 7: Sticker — <img alt="Sticker: ..."> is preserved ─────────────────

console.log('\n=== Test: Instagram sticker <img alt> preserved ===');

const stickerDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div data-message-id="ig1" class="bubble">
    <img alt="Sticker: cat waving hello" src="/sticker.webp">
  </div>
</body></html>`);

const stickerBubble = stickerDom.window.document.querySelector('.bubble');
const stickerText = bubbleText(stickerBubble);
assert(stickerText.includes('cat waving'), `sticker alt text preserved: got "${stickerText}"`);

// ─── Test 8: Empty alt is ignored (decorative image) ─────────────────────────

console.log('\n=== Test: empty alt is ignored ===');

const decorDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="bubble">
    <span dir="auto">Hello</span><img alt="" src="/decor.png">
  </div>
</body></html>`);

const decorBubble = decorDom.window.document.querySelector('.bubble');
const decorText = bubbleText(decorBubble);
assert(decorText === 'Hello', `empty alt image contributes nothing: got "${decorText}"`);

// ─── Test 9: Multi-emoji ZWJ sequences survive intact ────────────────────────

console.log('\n=== Test: ZWJ compound emoji survives ===');

const zwjDom = new JSDOM(`<!DOCTYPE html><html><body>
  <div class="bubble">
    <img alt="👨‍👩‍👧" src="/family.png">
  </div>
</body></html>`);

const zwjBubble = zwjDom.window.document.querySelector('.bubble');
const zwjText = bubbleText(zwjBubble);
assert(zwjText === '👨‍👩‍👧', `ZWJ compound intact: got "${zwjText}"`);

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
