# Manual Verification Checklist (Phases 1–9 + Settings page / output options)

The extension is fully wired and passes syntax + pure-module smoke-tests. The remaining
verification needs a real browser (selectable text, embedded links, lazy images,
screen-matching appearance, and the Chrome `debugger`/`downloads` APIs that can't run
headless). Run these in Chrome. Sections map to the build phases; the Phase 9 section is the
cross-mode integration pass, and the final section covers the **settings page + output/
workflow options**.

> **Settings moved to a page.** The ⚙ gear no longer opens an inline popup panel — it opens a
> dedicated **settings page** in its own tab with an explicit **Save** / **Cancel** model.
> Checks #19–#20, #49–#50, #53, #56 below are superseded by the **Settings page** section at
> the end; the functional behavior they describe (frame audit, settle delay, clamping,
> templates, close-tab) is now exercised there via the page + Save.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder
   (`CDP Screenshot`).
4. Confirm it loads as **"CDP Full-Page PDF"** with no errors. If there's an error,
   click **Errors** / **service worker** to inspect.

## Core checks

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 1 | A normal article (e.g. a Wikipedia or news article) | Click the toolbar icon → **Capture Page as PDF** | A `fullpage-<timestamp>.pdf` downloads. Status shows "Saved: …". |
| 2 | The same PDF | Open it in a PDF viewer | **Text is selectable** (drag-select / Ctrl+F finds words). Not a flat image. |
| 3 | The same PDF | Click a hyperlink in the captured content | **Link is clickable** and opens the original URL. |
| 4 | The same PDF | Compare to the page | Backgrounds/colors **match the on-screen look** (not a stripped-down print). |
| 5 | A lazy-loading image page (long page where images load on scroll) | Capture | Below-the-fold **images are present**, not blank. |
| 6 | A responsive site, browser window made **narrow** | Capture | PDF layout matches the **narrow on-screen layout**, not a wide reflow. |
| 7 | An extremely tall page (very long thread/feed, > ~200in tall) | Capture | Produces a **complete multi-page PDF** (status notes "paginated"), no failure. |
| 8 | `chrome://settings` | Click capture | Status shows the **guard error**: "Cannot capture browser/internal pages…". No download. |
| 9 | After any capture | Look at the browser | The **"… is debugging this browser"** banner disappears (debugger detached). |
| 10 | After capture on a page you'd scrolled | Look at the page | **Scroll position is unchanged** (auto-scroll restored it). |

## Blank-page fix (single tall page → exactly one page)

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 11 | A page that comfortably fits one tall sheet (e.g. a short landing page, like the SoftArchive home page) | Capture, then open the PDF | The PDF is **exactly one page** — **no blank trailing page** at the end. Bottom content (footer/whitespace) is intact, nothing clipped. |
| 12 | An extremely tall page (> ~200in) | Capture, then open the PDF | Still produces the **full paginated multi-page PDF** (status notes "paginated") — the fix didn't truncate long pages. (Regression check for #7.) |

## Stop button

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 13 | A long, lazy-loading page | Click **Capture Page as PDF** | The button immediately turns into a **red "Stop"** button while "Capturing…" shows. |
| 14 | Same, mid-capture | Click **Stop** during the auto-scroll/render | Capture **stops promptly** (doesn't scroll all the way first), status shows **"Cancelled."**, and **no file** is downloaded. |
| 15 | After clicking Stop | Look at the browser | The **"… is debugging this browser"** banner clears, and the page's **scroll position is restored**. |
| 16 | After clicking Stop | Look at the popup | Button returns to **"Capture Page as PDF"** and a **fresh capture works** immediately. |
| 17 | A normal page | Capture **without** clicking Stop | Happy path unchanged: PDF downloads, status "Saved: …", button reverts to idle. |
| 18 | A short page | Click Stop **right as it finishes** | Either cleanly **"Cancelled."** (no file) or a normal **"Saved: …"** — never a broken/partial PDF. |

## Settings gear (settle delay + frame audit)

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 19 | Any page | Click the **⚙** gear in the popup | An inline panel opens with two checkboxes: **"Wait for embeds to finish (settle delay)"** and **"Report iframes captured (frame audit)"**. |
| 20 | Any page | Flip both toggles, **close and reopen** the popup | The toggle states are **persisted** (loaded from `chrome.storage`). |
| 21 | A page with a cross-origin embed (e.g. a Vimeo/YouTube player or a Google Map) | **Settle delay ON**, capture | The embed renders **fully** in the PDF (compare with the toggle **off**, where a slow embed may come out blank/partial). |
| 22 | A long page, settle delay ON | Click **Stop** during the brief settle wait | Aborts promptly: **"Cancelled."**, no file, banner clears. |
| 23 | A page with mixed iframes (same- and cross-origin) | **Frame audit ON**, capture | Status appends e.g. **"3 iframes: 1 same-origin, 2 cross-origin (visual only)"** — counts match the page. |
| 24 | A plain page with no iframes | Frame audit ON, capture | Status appends **"— no iframes"**. |
| 25 | Both toggles **OFF** | Capture a normal page | Behavior is identical to before the settings existed (regression). |
| 26 | A page where the frame tree can't be read (e.g. immediately after load) | Frame audit ON, capture | Capture still **succeeds**; the audit summary is simply omitted (never fails the capture). |

## Capture-mode menu (Phase 1 scaffold)

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 27 | Any page | Open the popup | A **mode menu** is shown: **Entire page** (enabled) plus **Visible part / Selection / All tabs / Batch (URL list)** each marked **"soon"** and disabled. |
| 28 | A normal article | Click **Entire page** | Captures exactly as before — `fullpage-…pdf` downloads, status "Saved: …", blank-page fix and frame-audit behavior unchanged. The menu hides and a **Stop** button shows while capturing. |
| 29 | A long page | Click **Entire page**, then **Stop** | Cancels: "Cancelled.", no file, banner clears; the **menu reappears** ready for another capture. |
| 30 | Any page | Click a **disabled** mode (Selection / All tabs / Batch) | Nothing happens (no capture, no error). |

## Visible part (Phase 2 — translate-to-origin spike)

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 31 | A long page, scrolled **partway down** | Click **Visible part** | The PDF is **one page** showing exactly the on-screen viewport at the moment of capture (the scrolled region, not the top of the page). |
| 32 | The visible-part PDF | Open it, try to select text / click a link | **SPIKE CHECK:** text is **selectable** and links **clickable** (not rasterized). If text is flattened/misplaced, the spike failed → fall back to above-the-fold semantics (see PLAN Phase 2). |
| 33 | After a visible capture | Look at the page | The page is **visually unchanged**: scroll position restored, no leftover transform/shift. |
| 34 | A page scrolled partway, click Visible part then **Stop** during capture | — | Cancels cleanly ("Cancelled.", no file) **and the page is still restored** (no stuck transform). |

## Selection / element picker (Phase 3)

> Note: clicking onto the page to pick will **close the popup** (normal Chrome behavior). The
> capture still completes and the PDF downloads; the popup just won't show the "Saved" line.

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 35 | A content page (e.g. an article with cards/sections) | Click **Selection**, then hover the page | Elements **highlight** with a blue outline that tracks the cursor (devtools-style). |
| 36 | Same | **Click** one element (e.g. a single card/section) | A PDF downloads containing **just that element**, sized to it, with **selectable text and clickable links** preserved. |
| 37 | After a selection capture | Look at the page | Page is **fully restored**: no hidden siblings, no leftover transform/outline, scroll position intact. |
| 38 | During picking | Press **Escape** or **right-click** | The picker cancels: no capture, no download, page untouched (outline/cursor removed). |

## All tabs (Phase 4)

> Note: with `<all_urls>` host permission (added in the batch phase), background tabs now also
> get lazy-content pre-load. If you load the extension fresh, accept the host-access permission.

| # | Setup | What to do | Pass criteria |
|---|-------|-----------|---------------|
| 39 | A window with several normal tabs open | Click **All tabs** | One PDF downloads **per capturable tab** (unique `…-N.pdf` names); status ends e.g. **"all tabs: 5 saved"**. |
| 40 | A window that also has a `chrome://` tab open | Click **All tabs** | Internal tabs are **skipped** (not failed); status notes e.g. **"5 saved, 1 skipped"**. |
| 41 | During an all-tabs run | Watch the popup | Status shows live **progress**: "Capturing 3 of 8: <tab title>". |
| 42 | A window with many tabs | Click **All tabs**, then **Stop** midway | Run halts; status **"Stopped — N saved, …"**; already-saved PDFs remain; no stuck debugger banner. |
| 43 | After an all-tabs run | Look at the browser | Debugger detaches from every tab (no lingering "is debugging this browser" banner). |

## Batch (Phase 5)

| # | Setup | What to do | Pass criteria |
|---|-------|-----------|---------------|
| 44 | — | Open the popup, click **Batch (URL list)…** | A **batch page** opens in a new tab with a textarea + "Capture all" button. |
| 45 | Batch page | Paste a few URLs (mix of `https://…`, bare `example.com`, a blank line, a `#` comment), click **Capture all** | Each valid URL opens in a **background tab**, captures to its own `…-N.pdf`, and the tab **closes**; blanks/comments ignored; status shows progress then **"Done — N saved of M"**. |
| 46 | Batch page, a list with one bad/unreachable URL | Capture all | The bad one is counted **failed**; the rest still capture; summary notes "N saved, 1 failed". |
| 47 | Batch page, a long list | Click **Stop** midway | Run halts, opened tab closes, status **"Stopped — N saved…"**; already-saved PDFs remain. |
| 48 | Batch page | Paste only junk (no valid URLs), Capture all | Status **"No valid URLs found."**, nothing runs. |

## Settings — tuning fields (Phase 6)

> Note: the **Close tab after save** toggle persists here but only takes effect once wired in
> the next phase (templates + close-tab). Frame audit and the numeric fields are live now.

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 49 | Any page | Open the gear (⚙) | The panel shows numeric fields **Pre-capture delay (ms)**, **Scroll speed (ms/step)**, **Max scroll steps**, plus **Close tab after save** and **Report iframes** checkboxes — pre-filled with current values (defaults 400 / 120 / 400). |
| 50 | Gear | Change a number to an out-of-range value (e.g. delay `-5`, scroll speed `1`), click away | The field **clamps** to the valid value (delay → 0, scroll speed → 10) and the clamped value is shown; reopening the popup shows the **persisted** value. |
| 51 | A lazy-loading page | Set **Scroll speed** high (e.g. 400ms) and **Max scroll steps** low (e.g. 3), capture **Entire page** | Pre-load visibly scrolls slower and stops after fewer steps (tall pages may miss far-down lazy content — expected with a low cap). |
| 52 | Any page | Set **Pre-capture delay** to `0`, capture | No settle wait before printing (faster); set to e.g. `1500` and a slow embed page renders more completely. |

## Filename templates + close-tab (Phase 7)

| # | Page to open | What to do | Pass criteria |
|---|--------------|-----------|---------------|
| 53 | An article with a clear title | Gear → set **Filename** to `{title}-{date}`, capture Entire page | The downloaded file is named `<page title>-YYYY-MM-DD.pdf` (text selectable as before). |
| 54 | A page whose title has `/` or `:` | Set `{title}`, capture | Illegal characters are **sanitized** (no broken/failed download); file saves fine. |
| 55 | A window of several tabs | Keep a template without `{index}` (e.g. `{host}`), **All tabs** | Files don't collide — each gets a unique `-N` suffix appended automatically. |
| 56 | Any page | Gear → enable **Close tab after save**, capture Entire page | After the PDF saves, the **captured tab closes**. With it off, the tab stays. |
| 57 | A window of tabs | Enable Close-tab, run **All tabs** | All-tabs does **NOT** close your existing tabs (only single-mode captures honor close-tab); batch always closes its own temp tabs regardless. |

## History (Phase 8)

> History stores **metadata only** (title, site, date, filename) in `chrome.storage.local`.
> Re-open matches the stored filename to a real entry in Chrome's own download list — the
> PDF files themselves live in your Downloads folder, not in the extension.

| # | Setup | What to do | Pass criteria |
|---|-------|-----------|---------------|
| 58 | After capturing any page (Entire) | Open the popup, click **📁 View capture history** | A **history page** opens in a new tab listing the capture: title (linked to the page URL), host · date, and the `.pdf` filename. |
| 59 | The history page | Click **Open** on a row | The saved PDF **opens** (Chrome's download-open). With it missing/moved, see #62. |
| 60 | The history page | Click **Show** on a row | Chrome **reveals the file** in your OS file manager (Downloads folder). |
| 61 | History | Capture several pages across modes (Entire, Visible, Selection), reopen history | Every successful capture appears **automatically**, **newest first**, one row each — no manual save step. |
| 62 | History, then **delete** one of the PDFs from Downloads (or clear Chrome's download list) and reload the history page | — | That row shows **"file not found"** instead of Open/Show buttons; it never errors the page. The metadata row remains. |
| 63 | History | Click **Clear all** | The list **empties**, the "No captures yet…" empty state shows, and **Clear all** disables. Reopening the popup→history confirms it stays cleared (persisted). |
| 64 | A multi-capture run (**All tabs** or **Batch**) | Run it, then open history | **Each** saved file from the run is recorded as its own row (with the `-N`/`{index}` filenames). |
| 65 | Title with odd characters, or a tab with no title | Capture, open history | The row renders safely (no broken layout / injected markup); a title-less capture shows the host or "(untitled capture)". |

## Phase 9 — Cross-mode integration

Final pass: confirm the shared behaviors (Stop, the blank-page fix, debugger cleanup, history
recording) hold uniformly across **every** mode, not just the one each was built in.

### Stop works in every mode

| # | Mode | What to do | Pass criteria |
|---|------|-----------|---------------|
| 66 | Entire | Capture a long page, click **Stop** mid-scroll | "Cancelled.", no file, no history row, banner clears, scroll restored, menu returns. |
| 67 | Visible | Click **Visible part**, **Stop** during capture | "Cancelled.", no file, no history row, **page fully restored** (no stuck transform). |
| 68 | Selection | Pick an element, **Stop** during isolate/print | "Cancelled.", no file, no history row, **page fully restored** (no hidden siblings / leftover transform). |
| 69 | All tabs | Start, **Stop** midway | "Stopped — N saved…", already-saved files + their history rows remain, no lingering debugger banner on any tab. |
| 70 | Batch | Start a list, **Stop** midway | "Stopped — N saved…", the in-flight temp tab closes, already-saved files + history rows remain. |

### Blank-page fix holds for the single-page modes

| # | Mode | What to do | Pass criteria |
|---|------|-----------|---------------|
| 71 | Visible | Capture a partly-scrolled page | The PDF is **exactly one page** (the viewport) — no trailing blank page. |
| 72 | Selection | Capture a single element | The PDF is **exactly one page** sized to the element — no trailing blank page. |
| 73 | Entire (regression) | Capture a page that fits one tall sheet, then a >200in page | Single-sheet page → **one page, no blank trailer**; very tall page → still **paginated multi-page** (re-confirms #11/#12 after all later changes). |

### Debugger / state cleanup across modes

| # | Mode | What to do | Pass criteria |
|---|------|-----------|---------------|
| 74 | Each mode in turn | Capture once per mode (Entire, Visible, Selection, All tabs, Batch) | After each, the **"… is debugging this browser" banner clears** (debugger detaches); a fresh capture in any mode works immediately afterward. |
| 75 | After a full sweep of all modes | Open history | History contains **one row per successful capture** from the sweep, newest first, with working Open/Show. |

## Settings page + output/workflow options

The ⚙ gear opens a dedicated **settings page** (its own tab) with an explicit **Save** /
**Cancel** model. These checks supersede #19–#20, #49–#50, #53, #56.

### Page, Save/Cancel model

| # | What to do | Pass criteria |
|---|-----------|---------------|
| 76 | Click the **⚙** gear in the popup | The **settings page opens in a new tab** (popup closes). No inline panel appears. |
| 77 | Look at the page on open | All controls are **pre-filled with current saved values** (defaults: delay 400 / speed 120 / steps 400 / scroll-time 0 / padding 3 / length 100 / retention All; subfolder empty; checkboxes off). |
| 78 | Change several fields, click **Save** | A transient **"Saved ✓"** shows; reopening the page shows the **persisted** values. |
| 79 | Change fields, then click **Cancel** (or just close the tab) | Edits are **discarded** — reopening shows the previous saved values, not the abandoned edits. |
| 80 | Set out-of-range numbers (e.g. padding `99`, length `1`, delay `-5`), click **Save** | Values are **clamped on save** and the corrected values are shown (padding → 10, length → 10, delay → 0). |

### Output — show in folder & subfolder

| # | What to do | Pass criteria |
|---|-----------|---------------|
| 81 | Enable **Show downloaded file in folder after saving**, Save, capture **Entire page** | After the PDF saves, the OS file manager **opens with the file revealed**. |
| 82 | With it on, run **All tabs** (or **Batch**) | The folder is revealed **once at the end** — not one window per file. |
| 83 | Turn it **off**, capture | No file-manager window opens (silent save). |
| 84 | (Optional) Temporarily break reveal | A reveal failure **never fails the capture** — the PDF still saves and status is normal. |
| 85 | Set **Output subfolder** to `Captures`, Save, capture in each mode (entire/visible/selection/all-tabs/batch) | Every file lands in **`Downloads/Captures/`**. |
| 86 | Set subfolder to an **invalid** value (`/etc`, `C:\x`, `../up`), Save | It's **sanitized/rejected** — the field shows the cleaned value (empty for those), and saving never fails. Empty subfolder → files in **Downloads root**. |

### Filename — presets, padding, length

| # | What to do | Pass criteria |
|---|-----------|---------------|
| 87 | Click the **FireShot style** preset button | The template field fills with `FireShot Capture {index} - {title} - [{host}]` (not yet saved until you Save). |
| 88 | With the FireShot preset saved, capture a **single** page | The filename renders without a doubled space where `{index}` is empty (e.g. `FireShot Capture - <title> - [<host>].pdf`). |
| 89 | Set **Index zero-padding** to `3`, run **All tabs** with a template containing `{index}` (or none) | Multi-capture numbers are padded: `001`, `002`, … (and the auto `-N` suffix is padded too). |
| 90 | Set padding to `0`, run All tabs | Numbers are **not padded** (`-1`, `-2`, …). |
| 91 | Set **Filename length limit** to a small value (e.g. `20`) on a long-title template, capture | The saved filename is **capped** at that length; with the default `100`, long titles are trimmed to 100. |
| 92 | A title with `/` or `:` after applying any preset | Illegal characters are still **sanitized** — the download never fails. |

### Capture — all-tabs-visible-only & scroll-time cap

| # | What to do | Pass criteria |
|---|-----------|---------------|
| 93 | Enable **All tabs captures visible part only**, Save, run **All tabs** on a window of long pages | Each tab produces a **one-page (viewport) PDF**, captured quickly without full-page scrolling. |
| 94 | Turn it **off**, run All tabs | Tabs capture **full-page** as before (regression). |
| 95 | Set **Limit scrolling time** to e.g. `3` s, Save, capture a very long / infinite-feed page | The pre-scroll **stops after ~3 s** (or when max steps hits first), then captures whatever loaded — it doesn't stall indefinitely. |
| 96 | Set scroll-time to `0`, capture the same page | No time cap — the **max-steps cap alone** governs the scroll (regression). |

### History retention

| # | What to do | Pass criteria |
|---|-----------|---------------|
| 97 | Set **Keep history for** to a short window, Save | The selection persists (reopen the page to confirm). |
| 98 | With a short window selected, capture a new page | On **record**, entries older than the window are pruned; the new capture appears. |
| 99 | Open the **history page** with old entries present and a short window set | Pruning also runs **on history open** — stale entries are gone from the list (and storage). |
| 100 | Set retention to **All**, capture / open history | **Nothing is pruned** — every entry is kept (no expiry). |

### Migration / regression

| # | What to do | Pass criteria |
|---|-----------|---------------|
| 101 | Upgrade over an existing install (settings saved before this version) | Old settings **survive**; new fields get their defaults — no reset, no error on the settings page. |
| 102 | Sweep all five modes, Stop, close-tab, frame audit, and history once | Everything from #1–#75 still behaves as before — the new options **add** without removing any behavior. |

## Known limitations to watch for

- **Very large pages** are downloaded via a base64 `data:` URL; an extremely large PDF
  could hit a data-URL size limit. If a huge page fails to download, that's the likely cause.
- **Cross-origin iframes** may not be pre-scrolled (injection runs in the top frame).
- **Authentication walls / paywalls** capture whatever is currently rendered.

## If something fails

- Open `chrome://extensions` → the extension's **service worker** link → Console for errors.
- For capture-specific errors, the popup status shows the message thrown by the worker.
- Re-load the extension after any code change (the **↻** reload button on its card).

## Result

- [ ] All 102 checks pass → core + blank-page fix + Stop + 5 capture modes + tuning + templates
  + close-tab + history + the Phase 9 cross-mode integration pass + the settings page and
  output/workflow options (show-in-folder, subfolder, presets/padding/length, all-tabs
  visible-only, scroll-time cap, history retention).
- [ ] Note any failures here with the page URL and the popup/console message.
