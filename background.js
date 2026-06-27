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

  // Use a Blob URL to avoid Chrome's ~2 MB data: URL size cap.
  // URL.createObjectURL is available in MV3 service workers.
  const blob    = new Blob([jsonStr], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);

  chrome.downloads.download({ url: blobUrl, filename: fullPath, saveAs: false }, downloadId => {
    URL.revokeObjectURL(blobUrl); // Chrome has already queued the read; safe to release
    const err = chrome.runtime.lastError;
    sendResponse({ ok: !err, downloadId, error: err ? err.message : null });
  });

  return true; // keep message channel open for the async sendResponse
});
