# CDP Full-Page PDF

A Manifest V3 Chrome extension that saves web pages as PDFs you can actually select text in and click links from. It drives the Chrome DevTools Protocol (`chrome.debugger` → `Page.printToPDF`) instead of stitching screenshots, so the page is rendered once as a real document. No tiling, no repeated viewport, no flattened image.

You can grab the entire scrollable page, just the visible part, a single element you point at, several elements at once, a rectangle you draw, every open tab, or a list of URLs you paste in. And for the pages that defeat a normal print — virtualized feeds, heavy sticky layouts — there's a Robust mode that screenshots the page but keeps the text selectable and the links clickable.

## Screenshots

| Popup — capture modes | Settings page |
|:---:|:---:|
| <img src="screenshots/popup.jpg" alt="Extension popup with the seven capture modes" width="320"> | <img src="screenshots/settings.jpg" alt="Settings page with capture strategy, output, filename, capture tuning, history, and after-capture options" width="420"> |

## Features

- **Real full-page capture.** The whole scrollable page, not just what fits on screen.
- **Selectable, searchable text.** It's actual PDF text, not a picture of text.
- **Links survive.** Hyperlinks stay clickable and point where they originally did.
- **Looks like the screen, not a print stylesheet.** Capture uses screen media and keeps backgrounds, so colors and layout match the browser.
- **One tall page when it can.** A single continuous page sized to the content, which feels like a screenshot. If the page is taller than Chrome's ~200 in single-page limit, it falls back to paginated Letter pages.
- **Loads lazy content first.** It auto-scrolls to trigger lazy images and sections before capturing, then puts your scroll position back.
- **You can stop it.** While a capture runs the button turns into Stop. Hit it and the capture aborts on the spot: nothing saved, debugger detached, scroll restored.
- **A Robust mode for stubborn pages.** Some pages can't be printed faithfully — virtualized feeds that unmount off-screen items, heavy `fixed`/`sticky` layouts. Robust mode hardens the page and tries a vector capture first; if that comes out blank or truncated, it falls back to a full-page screenshot. The honest trade: when it can print vector, you get visible selectable text as usual; on the screenshot fallback the text is an *invisible* layer over the image — you can't see it as glyphs, but you can still select, search, and copy it, and links stay clickable. Off by default (Standard stays pure vector).
- **A proper settings page** (the ⚙ gear opens it in its own tab) with an explicit Save / Cancel. Edit as much as you like; nothing sticks until you click Save, and out-of-range numbers or invalid folders get corrected at that point.
- **Seven capture modes** from the popup: Entire page, Visible part (the current viewport as one page), Selection (a point-and-click element picker), Multi-select (pick several elements at once), Region (drag a rectangle), All tabs (one PDF per tab in the window), and Batch (paste a URL list and let it work through them one at a time). All of them produce a real selectable-text PDF.
- **Multi-select, your way.** Picking several elements can save as one combined file (their union), one file per element (numbered in page order), or a single multi-page PDF (one element per page).
- **Plenty to tune** on the settings page: the capture strategy (Standard vs Robust) and its raster options (PNG/JPEG, JPEG quality, resolution scale), the multi-select output shape, capture timing (pre-capture delay, scroll speed, max scroll steps, a scroll-time cap), filename templates with tokens (`{title} {host} {url} {date} {time} {year} {month} {day} {index}`) plus one-click presets, index zero-padding, a filename length limit, an output subfolder, reveal-in-folder after saving, an all-tabs visible-only toggle, history retention, close-tab-after-save, and a frame audit.
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
- **Multi-select** — like Selection, but build a set: click to add an element, click it again to drop it, with a running count. Enter captures, Escape or right-click backs out. The output shape (combined / one-per-element / multi-page) is set on the settings page.
- **Region** — drag a rectangle and capture exactly that area. The result is clipped to the rectangle, so a big element straddling the edge won't blow the size out. A tiny drag, Escape, or right-click cancels.
- **All tabs** — one PDF per capturable tab in the current window, skipping internal pages, with live progress.
- **Batch (URL list)…** — opens a page where you paste URLs. Each one is captured in its own background tab, one at a time, no babysitting needed.

While a capture is running the menu turns into a red **Stop** button. Stopping aborts right away: nothing is saved, the debugger detaches, any DOM changes are reverted, and your scroll position comes back.

The **⚙ gear** opens the settings page in its own tab. Edit freely, then click **Save** to apply. Nothing is written until you do, and Cancel (or just closing the tab) throws the edits away. What you can set:

- **Capture strategy** — Robust (the default: vector first, screenshot fallback) or Standard (pure vector `printToPDF`). The multi-select output shape (combined / one file per element / one multi-page PDF). And the raster options used on a fallback: image format (PNG is lossless, JPEG is smaller for photo-heavy pages), JPEG quality (1–100), and a resolution scale (1–3 — sharper at the same physical size). JPEG quality is only editable when the format is JPEG.
  - **Note:** under Robust, the sub-region modes (Selection, Multi-select, Region) *always* capture as a screenshot, never vector. This is deliberate: `Page.printToPDF` sizes the layout by paper width, so asking it for a sub-region re-lays-out the whole responsive page at that narrower width — the element reflows and gets clipped. A screenshot of the element's real on-screen rectangle is the only faithful result, and the invisible text + link layer keeps it selectable and clickable. Don't "optimize" these back to vector. (Entire/Visible/All-tabs stay vector-first because they print at the full page width.)
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
                                          │                  (Robust: also neutralize fixed/sticky, deeper scroll)
                                          ├─ (visible/selection/multi-select/region)
                                          │     ElementPicker / MultiElementPicker / RegionPicker
                                          │     → DomIsolation shifts the target(s) to the origin
                                          ├─ PdfCapturer   → CDP: screen-media emulation → layout metrics
                                          │                       → DimensionCalculator → Page.printToPDF   (vector)
                                          │     └─ Robust only, if the vector looks blank/truncated:
                                          │          RasterCapturer (Page.captureScreenshot)
                                          │          + TextLayerExtractor (invisible text + link boxes)
                                          │          → ImageToPdf  (screenshot + selectable text + links)
                                          ├─ Downloader    → render filename template → save PDF
                                          └─ History       → record {title, url, host, date, filename}
```

A single-page capture (entire, visible, selection, multi-select-combined, region) is clamped to `pageRanges: "1"` so a sub-pixel print-layout overflow can't tack on a trailing blank page.

`printToPDF` doesn't support a clip region, so the sub-region modes work by editing the DOM rather than cropping: translate the viewport, the picked element, the union of several picks, or a drawn rectangle to the origin, hide what's off-target, capture, then restore the page exactly as it was. The Stop button sends `CANCEL_CAPTURE` and cancels the token. Auto-scroll bails out, the debugger detaches early (which interrupts `printToPDF`), DOM changes are reverted, and no file is written.

**Robust strategy.** `printToPDF` works on the live DOM, so virtualized feeds and heavy `fixed`/`sticky` layouts can print blank or truncated. Robust mode first hardens the page (deeper scroll, neutralized fixed/sticky) and prints vector; a small heuristic (`printability`) then checks whether the result looks unprintable. If it does, it screenshots the region with `Page.captureScreenshot`, extracts the on-screen text runs and link rectangles, and assembles a PDF (`imageToPdf`) where the image carries the look while an invisible text layer (render mode `3 Tr`) and `/URI` link annotations keep it selectable and clickable. The result reports which path ran. The "one multi-page PDF" multi-select output merges the per-element vector PDFs with a small hand-rolled merger (`pdfMerge`); on the raster fallback it embeds one screenshot per page instead.

## Project structure

| File | Responsibility |
|------|----------------|
| `manifest.json` | MV3 config; permissions; module service worker; icon declarations |
| `icons/` | Toolbar / store icons (16 · 32 · 48 · 128 PNG) |
| `background.js` | Service worker — mode router + handlers (entire/visible/selection/multi-select/region/all-tabs/batch); orchestrates prepare → capture (vector, or Robust raster fallback) → download → record |
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
| `src/domIsolation.js` | Injected translate-to-origin: viewport (visible), single element (selection), the union of several picks (multi-select), one pick by index (per-element / multi-page), and an arbitrary rectangle (region) — each with an exact restore |
| `src/elementPicker.js` | Injected hover-highlight + click-to-pick single-element picker |
| `src/multiElementPicker.js` | Injected multi-pick: toggle a set of elements (running count), Enter commits in document order, Esc/right-click cancels |
| `src/regionPicker.js` | Injected rubber-band rectangle selector → drawn rect in document coords |
| `src/geometry.js` | Pure rectangle math (union, intersect, clip, scale). Currently unused — the page-injected routines that need this inline it (injected functions can't import a module); kept as a testable home for the math |
| `src/cdpSession.js` | Promisified `chrome.debugger` wrapper; guaranteed detach; early detach on abort |
| `src/pagePreparer.js` | Injected auto-scroll lazy-load (tunable speed/steps) + scroll restore; Robust adds deeper scroll + reversible `fixed`/`sticky` neutralization |
| `src/dimensionCalculator.js` | Pure paper-size logic (px→inch, single-page vs. paginate) |
| `src/pdfCapturer.js` | CDP `Page.printToPDF` orchestration (optional dimension override) — the vector path |
| `src/printability.js` | Pure-ish heuristic: does a vector capture look blank/truncated (→ raster fallback)? |
| `src/rasterCapturer.js` | CDP `Page.captureScreenshot` of a region/full page (scale, PNG/JPEG) — the raster path |
| `src/textLayerExtractor.js` | Injected: collect text runs + link rectangles in a region, for the invisible selectable layer |
| `src/imageToPdf.js` | Pure: wrap a screenshot into a PDF with an invisible text layer (`3 Tr`) + `/URI` link annotations; single- or multi-page |
| `src/pdfMerge.js` | Pure: merge several single-page vector PDFs into one multi-page PDF (the Standard multi-select multi-page output) |
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
- Virtualized and infinite-scroll feeds (Instagram grids, long social timelines, that sort of thing) can come out incomplete in Standard mode. The vector capture is a single `Page.printToPDF` of the live DOM, so it can only include what's in the DOM at print time. **Robust mode** is the answer here: when the vector result looks blank or truncated it falls back to a screenshot of the full content, keeping the text selectable and links clickable — the trade is that the text becomes an invisible layer over an image rather than visible vector glyphs. Bumping up the pre-capture delay (⚙) also helps if the cause is slow loading rather than windowing.
- The text layer on a Robust raster fallback is run-level (one box per text node) using a single base font, so selection highlighting is approximate and non-Latin/RTL scripts aren't covered — search and copy still work. Very tall feeds can also exceed the screenshot size limit, in which case the capture falls back to the paginated vector path with a clear status.
- Multi-select can produce a single merged multi-page PDF (one element per page). All tabs and Batch still save one PDF per capture — there's no cross-tab merged output.
- History is metadata only. It re-opens files through Chrome's own download list, so if you move or delete a PDF in Downloads, that entry will read "file not found".

## Development

- No build step and no dependencies — just load the folder unpacked.
- The pure modules can be exercised with Node during development, no browser required: `dimensionCalculator`, `settings` (clamp/merge + `validateSubfolder`), `urlList`, `filenameTemplate` (render + `padIndex` + `buildOutputPath` + presets), `history` (shape/merge + `prune`), `geometry` (rectangle math), `printability` (the fallback heuristic), `imageToPdf` (screenshot → PDF bytes), and `pdfMerge` (combine vector PDFs). `node --check <file>` will syntax-check any module.
- After an edit, reload the extension from `chrome://extensions` with the **↻** button.
- Toolbar and store icons live in `icons/` and are referenced from `manifest.json`.
- `VERIFY.md` has the manual in-browser checklist — 133 checks across every mode, strategy, and config option.
