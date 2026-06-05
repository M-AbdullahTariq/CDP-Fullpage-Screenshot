# CDP Full-Page PDF

A Manifest V3 Chrome extension that saves web pages as PDFs you can actually select text in and click links from. It drives the Chrome DevTools Protocol (`chrome.debugger` → `Page.printToPDF`) instead of stitching screenshots, so the page is rendered once as a real document. No tiling, no repeated viewport, no flattened image.

You can grab the entire scrollable page, just the visible part, a single element you point at, every open tab, or a list of URLs you paste in.

## Screenshots

| Popup — capture modes | Settings page |
|:---:|:---:|
| <img src="screenshots/popup.jpg" alt="Extension popup with the five capture modes" width="320"> | <img src="screenshots/settings.jpg" alt="Settings page with output, filename, capture tuning, history, and after-capture options" width="420"> |

## Features

- **Real full-page capture.** The whole scrollable page, not just what fits on screen.
- **Selectable, searchable text.** It's actual PDF text, not a picture of text.
- **Links survive.** Hyperlinks stay clickable and point where they originally did.
- **Looks like the screen, not a print stylesheet.** Capture uses screen media and keeps backgrounds, so colors and layout match the browser.
- **One tall page when it can.** A single continuous page sized to the content, which feels like a screenshot. If the page is taller than Chrome's ~200 in single-page limit, it falls back to paginated Letter pages.
- **Loads lazy content first.** It auto-scrolls to trigger lazy images and sections before capturing, then puts your scroll position back.
- **You can stop it.** While a capture runs the button turns into Stop. Hit it and the capture aborts on the spot: nothing saved, debugger detached, scroll restored.
- **A proper settings page** (the ⚙ gear opens it in its own tab) with an explicit Save / Cancel. Edit as much as you like; nothing sticks until you click Save, and out-of-range numbers or invalid folders get corrected at that point.
- **Five capture modes** from the popup: Entire page, Visible part (the current viewport as one page), Selection (a point-and-click element picker), All tabs (one PDF per tab in the window), and Batch (paste a URL list and let it work through them one at a time). All of them produce a real selectable-text PDF.
- **Plenty to tune** on the settings page: capture timing (pre-capture delay, scroll speed, max scroll steps, a scroll-time cap), filename templates with tokens (`{title} {host} {url} {date} {time} {year} {month} {day} {index}`) plus one-click presets, index zero-padding, a filename length limit, an output subfolder, reveal-in-folder after saving, an all-tabs visible-only toggle, history retention, close-tab-after-save, and a frame audit.
- **Capture history.** Every successful capture is logged (title, site, date, filename) on a history page with one-click Open / Show and Clear all. Old entries get pruned automatically based on the retention window you pick. It only stores metadata; the files themselves stay in your Downloads folder.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and pick this folder.
4. It shows up as **CDP Full-Page PDF**.

## Usage

Click the toolbar icon to open the capture menu and pick a mode:

- **Entire page** — the full scrollable document as one tall PDF (it paginates if the page is taller than Chrome's ~200 in single-page limit).
- **Visible part** — whatever's on screen right now, as a one-page PDF.
- **Selection** — hover to highlight elements devtools-style, click one to capture just that element. Escape or right-click backs out.
- **All tabs** — one PDF per capturable tab in the current window, skipping internal pages, with live progress.
- **Batch (URL list)…** — opens a page where you paste URLs. Each one is captured in its own background tab, one at a time, no babysitting needed.

While a capture is running the menu turns into a red **Stop** button. Stopping aborts right away: nothing is saved, the debugger detaches, any DOM changes are reverted, and your scroll position comes back.

The **⚙ gear** opens the settings page in its own tab. Edit freely, then click **Save** to apply. Nothing is written until you do, and Cancel (or just closing the tab) throws the edits away. What you can set:

- **Output** — reveal the downloaded file in its folder after saving (the file itself for a single capture, the folder once for all-tabs/batch), and an output subfolder under Downloads (e.g. `Captures`; leave it empty for the Downloads root; absolute paths and `..` are rejected).
- **Filename** — the template (tokens like `{title} {host} {date} {index}`), one-click presets including a title/host/index style, index zero-padding (defaults to 3, so `001`), and a filename length limit (defaults to 100).
- **Capture tuning** — pre-capture delay, scroll speed, max scroll steps, a scroll-time cap in seconds (0 turns it off), and an all-tabs-captures-visible-part-only toggle.
- **History** — the retention window (Week / 30 days / 3 months / 6 months / Year / All). Anything older is pruned automatically.
- **After capture** — close the tab after saving, and the frame-audit toggle.

The **📁 View capture history** link lists past captures with one-click Open / Show and Clear all.

Internal pages (`chrome://`, `edge://`, `about:`, extension pages) can't be captured and are turned away with a clear message.

## How it works

```
popup ── CAPTURE_FULL_PAGE {mode} ─▶ service worker  (holds a CancellationToken)
        ── CANCEL_CAPTURE ─────────▶      │  token.cancel() → abort signal
                                          │
                            mode router ──┤
                                          ├─ PagePreparer  → auto-scroll to load lazy content, restore scroll
                                          ├─ (visible/selection) ElementPicker / DomIsolation → shift target to origin
                                          ├─ PdfCapturer   → CDP: screen-media emulation → layout metrics
                                          │                       → DimensionCalculator → Page.printToPDF
                                          ├─ Downloader    → render filename template → save PDF
                                          └─ History       → record {title, url, host, date, filename}
```

A single-page capture (entire, visible, or selection) is clamped to `pageRanges: "1"` so a sub-pixel print-layout overflow can't tack on a trailing blank page.

`printToPDF` doesn't support a clip region, so the sub-region modes work by editing the DOM rather than cropping: translate the viewport or the picked element to the origin, hide everything else, capture, then restore the page exactly as it was. The Stop button sends `CANCEL_CAPTURE` and cancels the token. Auto-scroll bails out, the debugger detaches early (which interrupts `printToPDF`), DOM changes are reverted, and no file is written.

## Project structure

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 config; permissions; module service worker; icon declarations |
| `icons/` | Toolbar / store icons (16 · 32 · 48 · 128 PNG) |
| `background.js` | Service worker — mode router + handlers (entire/visible/selection/all-tabs/batch); orchestrates prepare → capture → download → record |
| `popup.html` / `popup.js` | Toolbar popup: mode menu, Stop, settings gear (opens the settings page), history link |
| `settings.html` / `settings.js` | Settings page — explicit Save/Cancel form over all persisted options |
| `batch.html` / `batch.js` | Batch page — paste a URL list, run/stop, progress |
| `history.html` / `history.js` | History page — list past captures, Open/Show, clear all |
| `src/cancellation.js` | `CancellationToken` (AbortController wrapper); powers the Stop button |
| `src/settings.js` | Persisted settings + pure clamp/merge/validate (tuning, template, output, retention, toggles) + `validateSubfolder` over `chrome.storage` |
| `src/history.js` | Capture history — pure shape/merge + `prune` (retention) helpers + `chrome.storage.local` record/list/clear |
| `src/urlList.js` | Pure parser: pasted blob → clean, de-duplicated http(s) URL list |
| `src/filenameTemplate.js` | Pure template render + filename sanitize (token substitution, index padding, length cap) + presets + output-path assembly |
| `src/frameAuditor.js` | Pure iframe classifier (same-origin vs cross-origin from the CDP frame tree) |
| `src/domIsolation.js` | Injected viewport translate-to-origin + element isolation (visible/selection) |
| `src/elementPicker.js` | Injected hover-highlight + click-to-pick element picker |
| `src/cdpSession.js` | Promisified `chrome.debugger` wrapper; guaranteed detach; early detach on abort |
| `src/pagePreparer.js` | Injected auto-scroll lazy-load (tunable speed/steps) + scroll restore |
| `src/dimensionCalculator.js` | Pure paper-size logic (px→inch, single-page vs. paginate) |
| `src/pdfCapturer.js` | CDP `Page.printToPDF` orchestration (optional dimension override) |
| `src/downloader.js` | Template/timestamped filename + optional subfolder + `chrome.downloads` (returns the download id for reveal-in-folder); guarantees the name via an `onDeterminingFilename` hook (the `filename` option alone is unreliable for `data:` URLs / when other download extensions are installed) |

## Permissions

| Permission | Why |
|------------|-----|
| `debugger` | Drive CDP `Page.printToPDF` / layout metrics |
| `scripting` | Inject the auto-scroll lazy-load routine |
| `downloads` | Save the resulting PDF |
| `downloads.open` | Re-open a past capture from the history page (one-click Open) |
| `tabs` | Read tab URLs/titles (internal-page guard, all-tabs, batch background tabs) |
| `activeTab` | Operate on the current tab on user action |
| `storage` | Persist settings + capture history metadata |
| `host_permissions: <all_urls>` | Inject pre-load / drive the debugger on all-tabs and batch (foreign) tabs |

## Limitations

A few things to know going in:

- Very large pages download through a base64 `data:` URL, so an enormous PDF can run into a data-URL size limit.
- Same-origin iframes get pre-scrolled (the injection runs in every reachable frame), but cross-origin iframes can't be driven — that's a browser security boundary. They'll still render into the PDF if they're already loaded, but their lazy content and inner links won't be captured.
- Pages taller than Chrome's ~200 in single-page cap fall back to paginated output.
- Virtualized and infinite-scroll feeds (Instagram grids, long social timelines, that sort of thing) can come out incomplete. The capture is a single `Page.printToPDF` of the live DOM, so it can only include what's in the DOM at print time. Sites that unmount off-screen items as you scroll, or that load content after the pre-scroll finishes, never have everything mounted at once, so parts of the feed can be blank or missing. That's the price of a real text/vector PDF; image-stitching tools dodge it by producing a flattened screenshot instead. Bumping up the pre-capture delay (⚙) helps if the cause is slow loading rather than windowing.
- All tabs and Batch save one PDF per capture. There's no merged-PDF output.
- History is metadata only. It re-opens files through Chrome's own download list, so if you move or delete a PDF in Downloads, that entry will read "file not found".

## Development

- No build step and no dependencies — just load the folder unpacked.
- The pure modules can be exercised with Node during development, no browser required: `dimensionCalculator`, `settings` (clamp/merge + `validateSubfolder`), `urlList`, `filenameTemplate` (render + `padIndex` + `buildOutputPath` + presets), and `history` (shape/merge + `prune`). `node --check <file>` will syntax-check any module.
- After an edit, reload the extension from `chrome://extensions` with the **↻** button.
- Toolbar and store icons live in `icons/` and are referenced from `manifest.json`.
- `VERIFY.md` has the manual in-browser checklist — 75 checks across every mode and config option.
