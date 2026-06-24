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

  // Encode the JSON string into a data: URL so no blob URL cross-process transfer is needed.
  const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(jsonStr);

  chrome.downloads.download({ url: dataUrl, filename: fullPath, saveAs: false }, downloadId => {
    const err = chrome.runtime.lastError;
    sendResponse({ ok: !err, downloadId, error: err ? err.message : null });
  });

  return true; // keep message channel open for the async sendResponse
});
