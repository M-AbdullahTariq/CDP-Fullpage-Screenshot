// Service worker (ES module): captures the active tab as a PDF with selectable
// text and embedded clickable links via CDP Page.printToPDF.
//
// A capture request carries a `mode`. The router dispatches to the matching
// handler. Today only `entire` (the full page) is wired; the other modes are
// scaffolded and report "not yet available".
//
// Entire flow: pre-load lazy content (PagePreparer) -> render PDF (PdfCapturer)
// -> download (Downloader). PDF is the only output.

import { capturePdf } from "./src/pdfCapturer.js";
import { preparePage } from "./src/pagePreparer.js";
import { download } from "./src/downloader.js";
import { CancellationToken, isCancelled } from "./src/cancellation.js";
import { loadSettings } from "./src/settings.js";
import { PX_PER_INCH } from "./src/dimensionCalculator.js";
import {
  applyVisibleViewport,
  restoreVisibleViewport,
  isolateSelected,
  restoreSelected,
} from "./src/domIsolation.js";
import { pickElement } from "./src/elementPicker.js";
import { render as renderFilename, padIndex } from "./src/filenameTemplate.js";
import { recordCapture } from "./src/history.js";

// The single in-flight capture's cancellation token, or null when idle.
let activeToken = null;

// Modes the UI may offer; only those with a handler below actually run.
const KNOWN_MODES = ["entire", "visible", "selection", "all-tabs", "batch"];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Stop button: cancel the in-flight capture (no-op if nothing is running).
  if (message?.type === "CANCEL_CAPTURE") {
    activeToken?.cancel();
    sendResponse({ ok: true });
    return false;
  }

  // Batch run, started from the batch page with a parsed URL list.
  if (message?.type === "RUN_BATCH") {
    runWithToken((token) => captureBatch(message.urls || [], token), sendResponse);
    return true;
  }

  if (message?.type !== "CAPTURE_FULL_PAGE") return false;

  const mode = message.mode || "entire";
  runWithToken((token) => runCapture(mode, token), sendResponse);
  return true; // keep the message channel open for the async response
});

/** Run a capture under a fresh cancellation token, mapping errors to a response. */
function runWithToken(fn, sendResponse) {
  (async () => {
    const token = new CancellationToken();
    activeToken = token;
    try {
      sendResponse(await fn(token));
    } catch (err) {
      if (isCancelled(err) || token.aborted) {
        sendResponse({ ok: false, cancelled: true });
      } else {
        sendResponse({ ok: false, error: err.message });
      }
    } finally {
      if (activeToken === token) activeToken = null;
    }
  })();
}

/** Dispatch a capture request to its mode handler. */
async function runCapture(mode, token) {
  switch (mode) {
    case "entire":
      return captureEntire(token);
    case "visible":
      return captureVisible(token);
    case "selection":
      return captureSelection(token);
    case "all-tabs":
      return captureAllTabs(token);
    case "batch":
      return { ok: false, error: `"${mode}" mode is not yet available.` };
    default:
      return {
        ok: false,
        error: KNOWN_MODES.includes(mode)
          ? `"${mode}" mode is not yet available.`
          : `Unknown capture mode: "${mode}".`,
      };
  }
}

/** Internal/restricted pages can't be captured (no debugger/script access). */
function isInternalUrl(url) {
  return /^(chrome|edge|about|chrome-extension):/.test(url || "");
}

/** The active tab, or throw if missing / an un-capturable internal page. */
async function getCapturableActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  if (isInternalUrl(tab.url)) {
    throw new Error("Cannot capture browser/internal pages (chrome://, etc.).");
  }
  return tab;
}

/** Build the page-prep tuning options from persisted settings. */
function prepOptions(settings) {
  return {
    preCaptureDelayMs: settings.preCaptureDelayMs,
    scrollSpeedMs: settings.scrollSpeedMs,
    maxScrollSteps: settings.maxScrollSteps,
    maxScrollSeconds: settings.maxScrollSeconds,
  };
}

/** Push a progress update to the popup (ignored if the popup is closed). */
function sendProgress(current, total, title) {
  chrome.runtime
    .sendMessage({ type: "CAPTURE_PROGRESS", current, total, title: title || "" })
    .catch(() => {});
}

/** Build the filename-template token values for a tab at capture time. */
function captureTokens(tab, index) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const year = String(now.getFullYear());
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  let host = "";
  try {
    host = tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    host = "";
  }
  return {
    title: tab?.title || "",
    url: tab?.url || "",
    host,
    date: `${year}-${month}-${day}`,
    time: `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`,
    year,
    month,
    day,
    index: index != null ? String(index) : "",
  };
}

/**
 * Resolve the output base filename (no extension) from the user's template.
 * In multi-capture runs, append `-N` when the template omits {index} so files
 * stay unique.
 */
function buildFilename(settings, tab, index) {
  const opts = { maxLen: settings.filenameMaxLen, padZeros: settings.indexPadZeros };
  let base = renderFilename(settings.filenameTemplate, captureTokens(tab, index), opts);
  if (index != null && !/\{index\}/.test(settings.filenameTemplate)) {
    base += `-${padIndex(index, settings.indexPadZeros)}`;
  }
  return base;
}

/** Close the captured tab if the user enabled "close tab after save". */
async function maybeCloseTab(tabId, settings) {
  if (settings.closeTabAfter) await chrome.tabs.remove(tabId).catch(() => {});
}

/**
 * Reveal a saved download in the OS file manager when "show in folder" is on.
 * Best-effort — a reveal hiccup must never fail the capture. For a single
 * capture, pass that file's id; for a multi-capture run, pass any one saved id
 * (Chrome reveals its containing folder) once at the end.
 */
function maybeReveal(downloadId, settings) {
  if (!settings.showInFolderAfterSave || downloadId == null) return;
  try {
    chrome.downloads.show(downloadId);
  } catch {
    /* reveal is best-effort */
  }
}

/**
 * Record a successful capture in history (metadata only). Best-effort — a
 * history failure must never fail or block the capture itself.
 * @param {object} tab  the captured tab (for title/url)
 * @param {string} savedFilename  the on-disk filename returned by download()
 */
async function recordHistory(tab, savedFilename) {
  if (!savedFilename) return;
  const t = captureTokens(tab);
  try {
    await recordCapture({
      title: t.title,
      url: t.url,
      host: t.host,
      date: t.date,
      filename: savedFilename,
      ts: Date.now(), // sortable epoch ms for retention pruning
    });
  } catch {
    /* history is best-effort */
  }
}

/** Capture the entire active page as a PDF. */
async function captureEntire(token) {
  const tab = await getCapturableActiveTab();
  const settings = await loadSettings();

  // Trigger lazy-loaded content before measuring/printing.
  await preparePage(tab.id, token, prepOptions(settings));
  token.throwIfAborted();

  const { base64, paginated, audit } = await capturePdf(tab.id, token, {
    audit: settings.frameAudit,
  });
  token.throwIfAborted(); // stop before downloading if cancelled late

  const { filename, downloadId } = await download({
    base64,
    mimeType: "application/pdf",
    ext: "pdf",
    filename: buildFilename(settings, tab),
    subfolder: settings.outputSubfolder,
  });

  await recordHistory(tab, filename);
  maybeReveal(downloadId, settings);
  await maybeCloseTab(tab.id, settings);
  return { ok: true, filename, paginated, audit };
}

/**
 * Capture just the current on-screen viewport as a one-page PDF. We shift the
 * document so the visible region sits at the top, print a single viewport-sized
 * page, then always restore the page (no pre-scroll — we want the viewport as-is).
 */
async function captureVisible(token) {
  const tab = await getCapturableActiveTab();
  const settings = await loadSettings();

  const { width, height } = await applyVisibleViewport(tab.id);
  let result;
  let revealId;
  try {
    if (!(width > 0 && height > 0)) {
      throw new Error("Could not measure the visible viewport.");
    }
    token.throwIfAborted();

    const dims = {
      paperWidthIn: Math.ceil(width) / PX_PER_INCH,
      paperHeightIn: Math.ceil(height) / PX_PER_INCH,
      paginate: false, // single viewport page -> printOptions clamps to page 1
    };

    const { base64, paginated, audit } = await capturePdf(tab.id, token, {
      dims,
      audit: settings.frameAudit,
    });
    token.throwIfAborted();

    const dl = await download({
      base64,
      mimeType: "application/pdf",
      ext: "pdf",
      filename: buildFilename(settings, tab),
      subfolder: settings.outputSubfolder,
    });
    revealId = dl.downloadId;

    result = { ok: true, filename: dl.filename, paginated, audit };
  } finally {
    await restoreVisibleViewport(tab.id); // restore even on error/cancel
  }

  await recordHistory(tab, result.filename);
  maybeReveal(revealId, settings);
  await maybeCloseTab(tab.id, settings);
  return result;
}

/**
 * Capture a single user-picked element as a PDF. Run the element picker, then
 * isolate that element (hide everything else + shift it to the origin), print it
 * at its own size, and restore the page.
 */
async function captureSelection(token) {
  const tab = await getCapturableActiveTab();
  const settings = await loadSettings();

  const pick = await pickElement(tab.id);
  if (!pick?.picked) return { ok: false, cancelled: true }; // user cancelled / escaped

  const iso = await isolateSelected(tab.id);
  let result;
  let revealId;
  try {
    if (!iso?.ok || !(iso.width > 0 && iso.height > 0)) {
      throw new Error("Could not isolate the selected element.");
    }
    token.throwIfAborted();

    const dims = {
      paperWidthIn: iso.width / PX_PER_INCH,
      paperHeightIn: iso.height / PX_PER_INCH,
      paginate: false, // single element -> printOptions clamps to page 1
    };

    const { base64, paginated, audit } = await capturePdf(tab.id, token, {
      dims,
      audit: settings.frameAudit,
    });
    token.throwIfAborted();

    const dl = await download({
      base64,
      mimeType: "application/pdf",
      ext: "pdf",
      filename: buildFilename(settings, tab),
      subfolder: settings.outputSubfolder,
    });
    revealId = dl.downloadId;

    result = { ok: true, filename: dl.filename, paginated, audit };
  } finally {
    await restoreSelected(tab.id); // restore even on error/cancel
  }

  await recordHistory(tab, result.filename);
  maybeReveal(revealId, settings);
  await maybeCloseTab(tab.id, settings);
  return result;
}

/**
 * Capture one tab's PDF (base64) for an all-tabs run. When `allTabsVisibleOnly`
 * is set, capture just the current viewport (one page); if the viewport can't be
 * measured, fall back to a full-page capture so the tab still produces output.
 * @returns {Promise<string>} base64-encoded PDF
 */
async function captureTabPdfBase64(tabId, token, settings) {
  if (settings.allTabsVisibleOnly) {
    const { width, height } = await applyVisibleViewport(tabId);
    try {
      token.throwIfAborted();
      if (width > 0 && height > 0) {
        const dims = {
          paperWidthIn: Math.ceil(width) / PX_PER_INCH,
          paperHeightIn: Math.ceil(height) / PX_PER_INCH,
          paginate: false, // single viewport page
        };
        const { base64 } = await capturePdf(tabId, token, { dims, audit: false });
        return base64;
      }
      // viewport unmeasurable -> fall through to the full-page path below
    } finally {
      await restoreVisibleViewport(tabId);
    }
  }
  // Pre-load is best-effort: injection into non-active tabs may be blocked
  // without broad host permission, in which case capture proceeds as-is.
  await preparePage(tabId, token, prepOptions(settings));
  token.throwIfAborted();
  const { base64 } = await capturePdf(tabId, token, { audit: false });
  return base64;
}

/**
 * Capture every capturable tab in the current window, one PDF file each.
 * Internal pages are skipped; failures on one tab don't stop the rest; Stop
 * halts the queue and keeps already-saved files. Reports a summary.
 */
async function captureAllTabs(token) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const capturable = tabs.filter((t) => t.id && !isInternalUrl(t.url));
  const skippedInternal = tabs.length - capturable.length;
  const settings = await loadSettings();

  let saved = 0;
  let failed = 0;
  let cancelled = false;
  let lastDownloadId = null; // reveal the folder once at the end

  for (let i = 0; i < capturable.length; i++) {
    if (token.aborted) {
      cancelled = true;
      break;
    }
    const tab = capturable[i];
    sendProgress(i + 1, capturable.length, tab.title);
    try {
      const base64 = await captureTabPdfBase64(tab.id, token, settings);
      token.throwIfAborted();
      const { filename: name, downloadId } = await download({
        base64,
        mimeType: "application/pdf",
        ext: "pdf",
        filename: buildFilename(settings, tab, i + 1),
        subfolder: settings.outputSubfolder,
      });
      lastDownloadId = downloadId;
      await recordHistory(tab, name);
      saved++;
    } catch (err) {
      if (isCancelled(err) || token.aborted) {
        cancelled = true;
        break;
      }
      failed++; // skip this tab, keep going
    }
  }

  maybeReveal(lastDownloadId, settings); // once, for the whole run

  return {
    ok: true,
    multi: true,
    scope: "all tabs",
    total: capturable.length,
    saved,
    failed,
    skippedInternal,
    cancelled,
  };
}

/**
 * Capture a list of URLs, each in its own background tab, sequentially. Open →
 * wait for load → pre-load → capture → save → close. One bad URL doesn't stop
 * the rest; Stop halts the queue and keeps already-saved files.
 */
async function captureBatch(urls, token) {
  const settings = await loadSettings();
  let saved = 0;
  let failed = 0;
  let cancelled = false;
  let lastDownloadId = null; // reveal the folder once at the end

  for (let i = 0; i < urls.length; i++) {
    if (token.aborted) {
      cancelled = true;
      break;
    }
    sendProgress(i + 1, urls.length, urls[i]);

    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: urls[i], active: false });
      await waitForTabComplete(tab.id, token);
      token.throwIfAborted();

      await preparePage(tab.id, token, prepOptions(settings));
      token.throwIfAborted();

      const { base64 } = await capturePdf(tab.id, token, { audit: false });
      token.throwIfAborted();

      // Re-read the tab for an up-to-date title; fall back to the source URL.
      const info = await chrome.tabs.get(tab.id).catch(() => ({ url: urls[i] }));
      const { filename: name, downloadId } = await download({
        base64,
        mimeType: "application/pdf",
        ext: "pdf",
        filename: buildFilename(settings, info, i + 1),
        subfolder: settings.outputSubfolder,
      });
      lastDownloadId = downloadId;
      await recordHistory(info, name);
      saved++;
    } catch (err) {
      if (isCancelled(err) || token.aborted) cancelled = true;
      else failed++;
    } finally {
      if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
    }

    if (cancelled) break;
  }

  maybeReveal(lastDownloadId, settings); // once, for the whole run

  return {
    ok: true,
    multi: true,
    scope: "batch",
    total: urls.length,
    saved,
    failed,
    cancelled,
  };
}

/**
 * Resolve when the tab finishes loading, or on timeout / cancellation (so we
 * still attempt a capture of whatever loaded). Never rejects.
 */
function waitForTabComplete(tabId, token, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      token?.signal?.removeEventListener("abort", finish);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    token?.signal?.addEventListener("abort", finish, { once: true });
    // Catch the case where it's already complete before the listener attached.
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === "complete") finish();
      })
      .catch(() => {});
  });
}
