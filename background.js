'use strict';

/**
 * background.js — DM Extractor service worker
 *
 * Receives download requests from content scripts and saves JSON files into
 * per-context subfolders via chrome.downloads.download().
 *
 * Message shape: { action: 'download', folder: string, filename: string, jsonStr: string }
 * The folder and filename are combined into a single path; Chrome creates the
 * subfolder automatically under the default Downloads directory.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'download') return;

  const { folder, filename, jsonStr } = msg;

  // Sanitise path components — strip characters that are illegal in Windows/macOS/Linux folder names.
  const safeFolder   = (folder   || 'dm_extractor').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const safeFilename = (filename || 'download.json').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const fullPath     = safeFolder + '/' + safeFilename;

  // URL.createObjectURL is NOT available in MV3 service workers.
  // Use btoa + TextEncoder instead — both are available in SW and impose no size cap.
  // TextEncoder gives us the UTF-8 byte array; fromCharCode maps each byte to
  // a latin-1 char so btoa can base64-encode arbitrary Unicode content.
  const bytes  = new TextEncoder().encode(jsonStr);
  const chars  = Array.from(bytes, b => String.fromCharCode(b));
  const dataUrl = 'data:application/json;base64,' + btoa(chars.join(''));

  chrome.downloads.download({ url: dataUrl, filename: fullPath, saveAs: false }, downloadId => {
    const err = chrome.runtime.lastError;
    sendResponse({ ok: !err, downloadId, error: err ? err.message : null });
  });

  return true; // keep message channel open for the async sendResponse
});
