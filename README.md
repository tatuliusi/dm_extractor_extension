# DM Extractor — Meta Business Suite Batch Downloader

A Chrome extension (Manifest V3) that automates bulk conversation downloads from Meta Business Suite (Messenger, Instagram DMs, WhatsApp). It injects a floating control panel into the page, crawls the conversation list with virtual-scroll support, date-filters messages, and saves each conversation as a structured JSON file.


---

## Requirements

- **Google Chrome** 116 or later (Manifest V3 support required)
- A **Meta Business Suite** account with at least one connected inbox (Messenger, Instagram DMs, or WhatsApp)
- **Developer mode** enabled in Chrome extensions (no Web Store listing)

---

## Installation

1. Clone or download this repository to a local folder.
2. Open **chrome://extensions** in Chrome.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the folder containing `manifest.json`.
5. The extension is now active. Navigate to [business.facebook.com](https://business.facebook.com).

---

## How to Use

### Step 1 — Open an inbox

In Meta Business Suite, open the inbox you want to process:
- Click **Inbox** in the left navigation
- Select the inbox type tab: **Messenger**, **Instagram**, or **WhatsApp**

### Step 2 — Open the DM Extractor panel

A dark floating panel labelled **DM Extractor** appears in the bottom-right corner of the page. If it is collapsed, click the **▾** button to expand it.

### Step 3 — Set the date range

Use the **From** and **To** date pickers to define the window you want.  
Default: the current calendar month.

### Step 4 — Start

Click **▶ Start**.

The crawler will:
1. Detect all visible conversations in the left sidebar
2. Pre-filter each row by the last-message date shown in the sidebar (skips out-of-range conversations without opening them)
3. Scroll down automatically to load more (virtual scroll)
4. Click each in-range conversation, scroll to top to load full history, scroll back to bottom to restore newest messages, then extract
5. Apply the date filter — conversations with zero in-range messages are skipped
6. Save matching conversations as `dm_extractor_<name>_<timestamp>.json` inside a per-context subfolder in your Downloads folder (e.g. `messenger+123456789/`)

Watch the **status area** and **log** in the panel for live feedback.

### Step 5 — Pause / Resume / Stop

| Button | Behaviour |
|--------|-----------|
| **⏸ Pause** | Finishes the current conversation, then waits. Click **▶ Resume** to continue. |
| **■ Stop** | Halts immediately after the current operation. |

### Step 6 — Switch inbox type

When the crawl for one inbox finishes (or you stop it):
1. Click the next inbox tab (e.g. switch from **Messenger** to **WhatsApp**)
2. Press **▶ Start** again — the panel resets counters automatically

Repeat for each company account by switching the active account in the MBS top navigation.

---

## Output Format

Files are saved inside a per-context subfolder of your Downloads directory. The subfolder name is derived from the URL as `<platform>+<business_id>` (e.g. `messenger+527561502714866`). When a business_id is not present in the URL it falls back to just the platform name, and finally to `dm_extractor`. The panel logs the destination folder when a crawl starts.

Each downloaded file is a JSON object:

```json
{
  "thread": "Contact Name",
  "customer_name": "Contact Name",
  "url": "https://business.facebook.com/...",
  "extracted_at": "2025-05-15T10:23:00.000Z",
  "filtered": true,
  "filter_from": "2025-05-01",
  "filter_to": "2025-05-31",
  "count": 42,
  "messages": [
    {
      "id": "mid.xxx",
      "date": "May 3",
      "direction": "inbound",
      "text": "Hello, I have a question about…",
      "receipt": "Seen"
    }
  ]
}
```

`filtered: true` is only present when the date filter removed some messages from the full thread.  
`direction` is `"inbound"` (customer → you) or `"outbound"` (you → customer).

---

## Recovering Conversations Moved to Done

If the crawler accidentally moves conversations to the **Done** folder, navigate to the Done folder directly and move them back:

```
https://business.facebook.com/latest/inbox/{inbox_type}?asset_id={ASSET_ID}&business_id={BUSINESS_ID}&mailbox_id={MAILBOX_ID}&folder=DONE
```

Replace `{inbox_type}` with `instagram_direct`, `messenger`, or `whatsapp`.  
Copy `ASSET_ID`, `BUSINESS_ID`, and `MAILBOX_ID` from the URL of your active inbox — they look like long numeric strings.

**Example (Instagram):**

```
https://business.facebook.com/latest/inbox/instagram_direct?asset_id=807781679079979&business_id=527561502714866&mailbox_id=807781679079979&folder=DONE
```

Once in Done, select affected conversations and use **Mark as Open** to restore them.

---

## Known Limitations

| Limitation | Details |
|------------|---------|
| **Virtual scroll** | Meta only renders ~20–40 conversations at a time. The crawler scrolls and waits, but very large inboxes (500+ conversations) require the full scroll to finish before all are found. Do not interact with the page while the crawler is running. |
| **Obfuscated class names** | Extraction uses `aria-label`, `role`, and `data-*` selectors wherever possible. However two class names (`x1nhvcw1` / `x13a6bvl`) are used as fallbacks for message direction. Meta occasionally deploys class renames; if direction shows `"unknown"` for all messages after a Meta update, open an issue or update those two class names in `content.js → nearestDirection()`. |
| **Media messages** | Images, stickers, voice messages, and file attachments produce empty text and are currently omitted. Only text content is captured. |
| **Rate limits** | The crawler waits 1.5 s between conversations by default (`DELAY_BETWEEN_CONVS` in `content.js`). Reducing this may trigger Meta's rate limiting. |
| **Multi-page accounts** | If you manage multiple Facebook Pages inside one Business Manager, you must switch the active Page manually in MBS and re-run the crawler for each one. |
| **Session only** | Progress is kept in memory. Reloading the page resets everything. |

---

## File Structure

```
extension/
├── manifest.json               — Chrome MV3 manifest
├── background.js               — Service worker: receives download requests, saves JSON into per-context subfolders via chrome.downloads
├── content.js                  — Main logic: panel injection, extraction, crawler
├── utils.js                    — Helpers: date parsing, DOM waiting, sleep, getContextFolder
├── panel.html                  — Panel UI template (injected into Shadow DOM)
├── panel.css                   — Panel styles (isolated in Shadow DOM)
├── panel.js                    — Panel interaction (buttons, log, progress)
├── integration_test.js         — End-to-end tests driven against Chrome for Testing
├── test_extraction.js          — Unit tests for message extraction logic
├── test_daterange_accuracy.js  — Date-range filter accuracy tests (60 assertions)
├── test_bugfixes.js            — Regression tests for specific bug fixes
└── README.md                   — This file
```

---

## Updating After a Meta Deploy

If MBS pushes an update that breaks extraction:

1. Open a conversation manually and inspect the message bubbles in DevTools
2. Find the new class name used for inbound vs outbound alignment
3. Update the two class names in `content.js` inside `nearestDirection()`
4. If the date divider detection breaks, similarly update the class check in `extract()`
5. Reload the extension at **chrome://extensions → DM Extractor → ⟳**
