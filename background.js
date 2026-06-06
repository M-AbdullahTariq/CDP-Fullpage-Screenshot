// Service worker (ES module): captures the active tab as a PDF with selectable
// text and embedded clickable links via CDP Page.printToPDF.
//
// A capture request carries a `mode`. The router dispatches to the matching
// handler: entire, visible, selection, multi-select, region, and all-tabs are
// wired; batch runs from its own page. Only `batch` here reports "not yet available".
//
// Entire flow: pre-load lazy content (PagePreparer) -> render PDF (PdfCapturer)
// -> download (Downloader). Sub-region modes (selection/multi-select/region) always
// rasterize under the Robust strategy because printToPDF can't faithfully size them.

import { capturePdf } from "./src/pdfCapturer.js";
import { preparePage, neutralizeFixedSticky, restoreHardening } from "./src/pagePreparer.js";
import { download } from "./src/downloader.js";
import { CancellationToken, isCancelled } from "./src/cancellation.js";
import { loadSettings } from "./src/settings.js";
import { PX_PER_INCH } from "./src/dimensionCalculator.js";
import {
  applyVisibleViewport,
  restoreVisibleViewport,
  isolateSelected,
  restoreSelected,
  isolateUnion,
  restoreUnion,
  isolateIndex,
  restoreIndex,
  applyRegionShift,
  restoreRegion,
} from "./src/domIsolation.js";
import { pickElement } from "./src/elementPicker.js";
import { pickMultiElements } from "./src/multiElementPicker.js";
import { pickRegion } from "./src/regionPicker.js";
import { render as renderFilename, padIndex } from "./src/filenameTemplate.js";
import { recordCapture } from "./src/history.js";
import { captureRaster } from "./src/rasterCapturer.js";
import { extractTextAndLinks } from "./src/textLayerExtractor.js";
import { buildImagePdf, buildMultiImagePdf, pdfBytesToBase64 } from "./src/imageToPdf.js";
import { mergePdfsToBase64 } from "./src/pdfMerge.js";
import { looksUnprintable, probePrintability } from "./src/printability.js";

// The single in-flight capture's cancellation token, or null when idle.
let activeToken = null;

// Modes the UI may offer; only those with a handler below actually run.
const KNOWN_MODES = ["entire", "visible", "selection", "multi-select", "region", "all-tabs", "batch"];

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
    case "multi-select":
      return captureMultiSelect(token);
    case "region":
      return captureRegion(token);
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

/**
 * Save one PDF (base64) for a single-file capture, then record history, reveal, and
 * close-tab per settings. Returns the success response (merged with `extra` fields).
 */
async function saveSinglePdf(tab, settings, base64, extra = {}) {
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
  return { ok: true, filename, ...extra };
}

// --- Robust strategy (vector-first, raster fallback) ------------------------

/** Runs in the PAGE: measure full content + current viewport in document coords. */
function measurePageInjected() {
  const de = document.scrollingElement || document.documentElement;
  return {
    content: { left: 0, top: 0, width: Math.ceil(de.scrollWidth), height: Math.ceil(de.scrollHeight) },
    viewport: {
      left: Math.round(window.scrollX),
      top: Math.round(window.scrollY),
      width: Math.ceil(window.innerWidth),
      height: Math.ceil(window.innerHeight),
    },
  };
}

/** Document-coord content + viewport rects for a tab. */
async function measurePage(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: measurePageInjected });
  return res?.result ?? null;
}

/** Runs in the PAGE: the tagged selection's rect in document coords (or null). */
function measureSelectedInjected() {
  const el = document.querySelector('[data-cdp-selected="1"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: r.left + window.scrollX,
    top: r.top + window.scrollY,
    width: Math.ceil(r.width),
    height: Math.ceil(r.height),
  };
}

/** Document-coord rect of the currently picked element (or null). */
async function measureSelected(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: measureSelectedInjected });
  return res?.result ?? null;
}

/** Runs in the PAGE: union bbox of every multi-selected element, in document coords. */
function measureUnionInjected() {
  const sels = Array.from(document.querySelectorAll('[data-cdp-selected="1"]'));
  if (!sels.length) return null;
  let L = Infinity;
  let T = Infinity;
  let R = -Infinity;
  let B = -Infinity;
  for (const s of sels) {
    const r = s.getBoundingClientRect();
    L = Math.min(L, r.left + window.scrollX);
    T = Math.min(T, r.top + window.scrollY);
    R = Math.max(R, r.right + window.scrollX);
    B = Math.max(B, r.bottom + window.scrollY);
  }
  if (!(R > L && B > T)) return null;
  return { left: L, top: T, width: Math.ceil(R - L), height: Math.ceil(B - T) };
}

/** Document-coord union rect of all multi-selected elements (or null). */
async function measureUnion(tabId) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: measureUnionInjected });
  return res?.result ?? null;
}

/** Runs in the PAGE: the data-cdp-index="N" element's rect in document coords (or null). */
function measureIndexInjected(index) {
  const el = document.querySelector(`[data-cdp-index="${index}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: r.left + window.scrollX,
    top: r.top + window.scrollY,
    width: Math.ceil(r.width),
    height: Math.ceil(r.height),
  };
}

/** Document-coord rect of the indexed multi-select element (or null). */
async function measureIndex(tabId, index) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: measureIndexInjected,
    args: [index],
  });
  return res?.result ?? null;
}

/**
 * Given a vector capture result, decide (Robust strategy only) whether to keep it or
 * fall back to a raster image-PDF. Standard strategy always keeps the vector result.
 * The raster path screenshots `region` (document coords; full content when fullPage),
 * overlays an invisible selectable-text layer + clickable links, and embeds it as a
 * PDF. Returns the chosen payload plus a `fallback` flag for status reporting.
 * When `forceRaster` is set the printability probe is skipped and the raster path is taken
 * whenever a region exists. Sub-region modes (selection/multi-select/region) pass this:
 * printToPDF sizes the page by paper width, so on a responsive site it reflows the whole
 * document to the sub-region's narrow width and clips the element — a screenshot of the
 * element's real document rect is the only faithful result.
 * @returns {Promise<{ base64: string, paginated: boolean, audit: object|null, fallback: boolean }>}
 */
async function maybeRasterFallback(tabId, token, settings, vec, region, fullPage, forceRaster = false) {
  const keepVector = { base64: vec.base64, paginated: vec.paginated, audit: vec.audit, fallback: false };
  if (settings.captureStrategy !== "robust") return keepVector;

  let unprintable = forceRaster;
  if (!forceRaster) {
    try {
      // Scope the probe to what's actually being captured: whole page (fullPage) uses the
      // page-level heuristic; a sub-region only trips on a virtualization container that
      // overlaps it, so a static element on an otherwise-virtualized page stays vector.
      unprintable = looksUnprintable(await probePrintability(tabId, fullPage ? null : region));
    } catch {
      unprintable = false; // detection failure → trust the vector capture
    }
  }
  if (!unprintable || !region) return keepVector;

  // Build the raster fallback. If the raster path fails (e.g. the image exceeds Chrome's
  // screenshot size limit, or an unembeddable PNG), keep the vector PDF we already have
  // rather than failing the whole capture — a degraded-but-present result beats none.
  // A genuine cancellation must still propagate.
  try {
    const raster = await captureRaster(tabId, token, {
      clip: fullPage ? null : region,
      fullPage: !!fullPage,
      scale: settings.rasterScale,
      format: settings.rasterFormat,
      quality: settings.rasterJpegQuality,
    });
    token.throwIfAborted();
    const { textRuns, links } = await extractTextAndLinks(tabId, region);
    const bytes = buildImagePdf({
      image: raster.base64,
      format: raster.format,
      scale: raster.scale,
      textRuns,
      links,
    });
    return { base64: pdfBytesToBase64(bytes), paginated: false, audit: vec.audit, fallback: true };
  } catch (err) {
    if (isCancelled(err) || token.aborted) throw err; // don't swallow a real cancel
    return keepVector; // raster failed → ship the vector capture we already have
  }
}

/**
 * Robust vector attempt for a whole page: harden (neutralize fixed/sticky), printToPDF,
 * always un-harden, then measure the content region for a possible raster fallback.
 * Assumes enhanced pre-load already ran. Returns { vec, region }.
 */
async function robustVectorWholePage(tabId, token, audit) {
  await neutralizeFixedSticky(tabId);
  let vec;
  try {
    vec = await capturePdf(tabId, token, { audit });
  } finally {
    await restoreHardening(tabId); // restore before any raster so it sees the real page
  }
  token.throwIfAborted();
  const region = (await measurePage(tabId))?.content ?? null;
  return { vec, region };
}

/** Capture the entire active page as a PDF. */
async function captureEntire(token) {
  const tab = await getCapturableActiveTab();
  const settings = await loadSettings();
  const robust = settings.captureStrategy === "robust";

  // Trigger lazy-loaded content before measuring/printing (deeper pass when Robust).
  await preparePage(tab.id, token, { ...prepOptions(settings), enhanced: robust });
  token.throwIfAborted();

  let out;
  if (robust) {
    const { vec, region } = await robustVectorWholePage(tab.id, token, settings.frameAudit);
    out = await maybeRasterFallback(tab.id, token, settings, vec, region, true);
  } else {
    const vec = await capturePdf(tab.id, token, { audit: settings.frameAudit });
    out = { base64: vec.base64, paginated: vec.paginated, audit: vec.audit, fallback: false };
  }
  token.throwIfAborted(); // stop before downloading if cancelled late

  return saveSinglePdf(tab, settings, out.base64, {
    paginated: out.paginated,
    audit: out.audit,
    fallback: out.fallback,
  });
}

/**
 * Capture just the current on-screen viewport as a one-page PDF. We shift the
 * document so the visible region sits at the top, print a single viewport-sized
 * page, then always restore the page (no pre-scroll — we want the viewport as-is).
 */
async function captureVisible(token) {
  const tab = await getCapturableActiveTab();
  const settings = await loadSettings();
  const robust = settings.captureStrategy === "robust";

  const { width, height } = await applyVisibleViewport(tab.id);
  let vec;
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

    vec = await capturePdf(tab.id, token, { dims, audit: settings.frameAudit });
    token.throwIfAborted();
  } finally {
    await restoreVisibleViewport(tab.id); // restore even on error/cancel
  }

  // Robust fallback uses the real (restored) viewport region — document coords.
  let out;
  if (robust) {
    const region = (await measurePage(tab.id))?.viewport ?? null;
    out = await maybeRasterFallback(tab.id, token, settings, vec, region, false);
  } else {
    out = { base64: vec.base64, paginated: vec.paginated, audit: vec.audit, fallback: false };
  }

  return saveSinglePdf(tab, settings, out.base64, {
    paginated: out.paginated,
    audit: out.audit,
    fallback: out.fallback,
  });
}

/**
 * Capture a single user-picked element as a PDF. Run the element picker, then
 * isolate that element (hide everything else + shift it to the origin), print it
 * at its own size, and restore the page.
 */
async function captureSelection(token) {
  const tab = await getCapturableActiveTab();
  const settings = await loadSettings();

  const robust = settings.captureStrategy === "robust";

  const pick = await pickElement(tab.id, token.signal);
  if (!pick?.picked) return { ok: false, cancelled: true }; // user cancelled / escaped / Stop

  // Measure the element's real (pre-isolation) document rect for a possible raster
  // fallback — restoreSelected later drops the tag, so capture it now.
  const region = robust ? await measureSelected(tab.id) : null;

  const iso = await isolateSelected(tab.id);
  let vec;
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

    vec = await capturePdf(tab.id, token, { dims, audit: settings.frameAudit });
    token.throwIfAborted();
  } finally {
    await restoreSelected(tab.id); // restore even on error/cancel
  }

  // Robust fallback rasters the element's original rect on the restored page. Forced:
  // a vector sub-region print reflows to the element width and clips it (see note above).
  let out;
  if (robust) {
    out = await maybeRasterFallback(tab.id, token, settings, vec, region, false, true);
  } else {
    out = { base64: vec.base64, paginated: vec.paginated, audit: vec.audit, fallback: false };
  }

  return saveSinglePdf(tab, settings, out.base64, {
    paginated: out.paginated,
    audit: out.audit,
    fallback: out.fallback,
  });
}

/**
 * Capture multiple user-picked elements. Run the multi-element picker, then produce the
 * shape chosen by `multiSelectOutput`:
 *   • combined    → one file, the union of all picks (Standard: isolate the union and
 *     printToPDF; Robust: vector-first with a raster-of-the-union fallback).
 *   • per-element → one file per pick, each captured like a single selection.
 *   • multi-page  → one PDF, one page per pick (Standard: vector pages merged; Robust:
 *     one embedded raster image per page).
 * The picker tags the picks in document order; restoreUnion at the end clears all markers.
 */
async function captureMultiSelect(token) {
  const tab = await getCapturableActiveTab();
  const settings = await loadSettings();
  const robust = settings.captureStrategy === "robust";

  const pick = await pickMultiElements(tab.id, token.signal);
  if (!pick?.picked || !pick.count) return { ok: false, cancelled: true };

  try {
    switch (settings.multiSelectOutput) {
      case "per-element":
        return await multiSelectPerElement(tab, token, settings, pick.count, robust);
      case "multi-page":
        return await multiSelectMultiPage(tab, token, settings, pick.count, robust);
      case "combined":
      default:
        return await multiSelectCombined(tab, token, settings, robust);
    }
  } finally {
    // Belt-and-suspenders: clear any leftover selection markers / isolation. For the
    // per-element and multi-page loops the markers persist between iterations and are
    // only dropped here; combined already restored (this is then a harmless no-op).
    await restoreUnion(tab.id);
  }
}

/** Combined output: one file enclosing the union of all picks. */
async function multiSelectCombined(tab, token, settings, robust) {
  // Measure the union's document rect BEFORE isolation (markers are dropped on restore),
  // so a Robust raster fallback can clip to it on the live page.
  const region = robust ? await measureUnion(tab.id) : null;

  const iso = await isolateUnion(tab.id);
  let vec;
  try {
    if (!iso?.ok || !(iso.width > 0 && iso.height > 0)) {
      throw new Error("Could not isolate the selected elements.");
    }
    token.throwIfAborted();
    const dims = {
      paperWidthIn: iso.width / PX_PER_INCH,
      paperHeightIn: iso.height / PX_PER_INCH,
      paginate: false,
    };
    vec = await capturePdf(tab.id, token, { dims, audit: settings.frameAudit });
    token.throwIfAborted();
  } finally {
    await restoreUnion(tab.id); // unhide, un-shift, drop markers — before any raster
  }

  const out = robust
    ? await maybeRasterFallback(tab.id, token, settings, vec, region, false, true)
    : { base64: vec.base64, paginated: vec.paginated, audit: vec.audit, fallback: false };

  return saveSinglePdf(tab, settings, out.base64, {
    paginated: out.paginated,
    audit: out.audit,
    fallback: out.fallback,
  });
}

/** Per-element output: capture each pick in document order as its own file. */
async function multiSelectPerElement(tab, token, settings, count, robust) {
  let saved = 0;
  let failed = 0;
  let cancelled = false;
  let lastDownloadId = null; // reveal the folder once at the end

  for (let i = 0; i < count; i++) {
    if (token.aborted) {
      cancelled = true;
      break;
    }
    sendProgress(i + 1, count, tab.title);
    try {
      // Robust raster fallback needs the element's live rect — measure before isolating.
      const region = robust ? await measureIndex(tab.id, i) : null;

      const iso = await isolateIndex(tab.id, i);
      let vec;
      try {
        if (!iso?.ok || !(iso.width > 0 && iso.height > 0)) {
          throw new Error(`Could not isolate element ${i + 1}.`);
        }
        token.throwIfAborted();
        const dims = {
          paperWidthIn: iso.width / PX_PER_INCH,
          paperHeightIn: iso.height / PX_PER_INCH,
          paginate: false,
        };
        vec = await capturePdf(tab.id, token, { dims, audit: settings.frameAudit });
        token.throwIfAborted();
      } finally {
        await restoreIndex(tab.id); // unhide + un-shift this pick, keep markers for the next
      }

      const out = robust
        ? await maybeRasterFallback(tab.id, token, settings, vec, region, false, true)
        : { base64: vec.base64, paginated: vec.paginated, audit: vec.audit, fallback: false };
      token.throwIfAborted();

      const { filename, downloadId } = await download({
        base64: out.base64,
        mimeType: "application/pdf",
        ext: "pdf",
        filename: buildFilename(settings, tab, i + 1),
        subfolder: settings.outputSubfolder,
      });
      lastDownloadId = downloadId;
      await recordHistory(tab, filename);
      saved++;
    } catch (err) {
      if (isCancelled(err) || token.aborted) {
        cancelled = true;
        break;
      }
      failed++; // skip this element, keep going
    }
  }

  maybeReveal(lastDownloadId, settings);
  await maybeCloseTab(tab.id, settings);
  return { ok: true, multi: true, scope: "selected elements", total: count, saved, failed, cancelled };
}

/** Multi-page output: one PDF, one page per pick. */
async function multiSelectMultiPage(tab, token, settings, count, robust) {
  // Robust: one embedded raster image per page (mixed vector/raster can't share a file).
  if (robust) {
    const base64 = await rasterMultiPage(tab, token, settings, count);
    return saveSinglePdf(tab, settings, base64, { paginated: false, multiPage: true, fallback: true });
  }

  // Standard: capture each pick as its own single-page vector PDF, then merge. A pick
  // that can't be isolated is skipped (consistent with per-element output) rather than
  // failing the whole file; cancellation still aborts the run.
  const parts = [];
  let skipped = 0;
  for (let i = 0; i < count; i++) {
    if (token.aborted) break;
    sendProgress(i + 1, count, tab.title);
    try {
      const iso = await isolateIndex(tab.id, i);
      try {
        if (!iso?.ok || !(iso.width > 0 && iso.height > 0)) {
          throw new Error(`Could not isolate element ${i + 1}.`);
        }
        const dims = {
          paperWidthIn: iso.width / PX_PER_INCH,
          paperHeightIn: iso.height / PX_PER_INCH,
          paginate: false,
        };
        const vec = await capturePdf(tab.id, token, { dims, audit: false });
        parts.push(vec.base64);
      } finally {
        await restoreIndex(tab.id);
      }
    } catch (err) {
      if (isCancelled(err) || token.aborted) throw err; // a real cancel aborts the run
      skipped++; // skip this element, keep the rest
    }
  }
  token.throwIfAborted();
  if (!parts.length) throw new Error("No capturable elements for the multi-page PDF.");

  // Merge the vector pages; if they can't be parsed, fall back to a raster multi-page PDF.
  let base64;
  let fallback = false;
  try {
    base64 = mergePdfsToBase64(parts);
  } catch {
    base64 = await rasterMultiPage(tab, token, settings, count);
    fallback = true;
  }
  return saveSinglePdf(tab, settings, base64, { paginated: false, multiPage: true, fallback, skipped });
}

/**
 * Build a raster multi-page PDF: screenshot each pick's region (with an invisible
 * selectable-text + links layer) and embed one image per page. Used by the Robust
 * multi-page path and as the Standard fallback when vector merging fails.
 * @returns {Promise<string>} base64 PDF
 */
async function rasterMultiPage(tab, token, settings, count) {
  const pages = [];
  for (let i = 0; i < count; i++) {
    token.throwIfAborted();
    sendProgress(i + 1, count, tab.title);
    const region = await measureIndex(tab.id, i);
    if (!region || !(region.width > 0 && region.height > 0)) continue;
    const raster = await captureRaster(tab.id, token, {
      clip: region,
      scale: settings.rasterScale,
      format: settings.rasterFormat,
      quality: settings.rasterJpegQuality,
    });
    token.throwIfAborted();
    const { textRuns, links } = await extractTextAndLinks(tab.id, region);
    pages.push({ image: raster.base64, format: raster.format, scale: raster.scale, textRuns, links });
  }
  if (!pages.length) throw new Error("No capturable elements for the multi-page PDF.");
  return pdfBytesToBase64(buildMultiImagePdf(pages));
}

/**
 * Capture a user-drawn rectangle as a PDF. Run the region picker, shift the document
 * so the drawn rect sits at the origin (no element hiding — the page is sized to the
 * rect so printToPDF yields exactly that region), print, and restore. Robust strategy
 * is vector-first with a raster fallback clipped to the same rect (document coords).
 */
async function captureRegion(token) {
  const tab = await getCapturableActiveTab();
  const settings = await loadSettings();
  const robust = settings.captureStrategy === "robust";

  const pick = await pickRegion(tab.id, token.signal);
  if (!pick?.picked || !pick.rect) return { ok: false, cancelled: true };

  const dimsRect = await applyRegionShift(tab.id, pick.rect);
  let vec;
  try {
    if (!(dimsRect.width > 0 && dimsRect.height > 0)) {
      throw new Error("Could not measure the region.");
    }
    token.throwIfAborted();
    const dims = {
      paperWidthIn: dimsRect.width / PX_PER_INCH,
      paperHeightIn: dimsRect.height / PX_PER_INCH,
      paginate: false,
    };
    vec = await capturePdf(tab.id, token, { dims, audit: settings.frameAudit });
    token.throwIfAborted();
  } finally {
    await restoreRegion(tab.id); // revert the transform/scroll — even on error
  }

  // The drawn rect is already in document coords — the space the raster path expects.
  const out = robust
    ? await maybeRasterFallback(tab.id, token, settings, vec, pick.rect, false, true)
    : { base64: vec.base64, paginated: vec.paginated, audit: vec.audit, fallback: false };

  return saveSinglePdf(tab, settings, out.base64, {
    paginated: out.paginated,
    audit: out.audit,
    fallback: out.fallback,
  });
}

/**
 * Capture one tab's PDF (base64) for an all-tabs run. When `allTabsVisibleOnly`
 * is set, capture just the current viewport (one page); if the viewport can't be
 * measured, fall back to a full-page capture so the tab still produces output.
 * @returns {Promise<string>} base64-encoded PDF
 */
async function captureTabPdfBase64(tabId, token, settings) {
  const robust = settings.captureStrategy === "robust";

  if (settings.allTabsVisibleOnly) {
    const { width, height } = await applyVisibleViewport(tabId);
    let vec = null;
    try {
      token.throwIfAborted();
      if (width > 0 && height > 0) {
        const dims = {
          paperWidthIn: Math.ceil(width) / PX_PER_INCH,
          paperHeightIn: Math.ceil(height) / PX_PER_INCH,
          paginate: false, // single viewport page
        };
        vec = await capturePdf(tabId, token, { dims, audit: false });
      }
      // viewport unmeasurable -> fall through to the full-page path below
    } finally {
      await restoreVisibleViewport(tabId);
    }
    if (vec) {
      if (!robust) return vec.base64;
      const region = (await measurePage(tabId))?.viewport ?? null;
      return (await maybeRasterFallback(tabId, token, settings, vec, region, false)).base64;
    }
  }
  // Pre-load is best-effort: injection into non-active tabs may be blocked
  // without broad host permission, in which case capture proceeds as-is.
  await preparePage(tabId, token, { ...prepOptions(settings), enhanced: robust });
  token.throwIfAborted();
  if (robust) {
    const { vec, region } = await robustVectorWholePage(tabId, token, false);
    return (await maybeRasterFallback(tabId, token, settings, vec, region, true)).base64;
  }
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
  const robust = settings.captureStrategy === "robust";
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

      await preparePage(tab.id, token, { ...prepOptions(settings), enhanced: robust });
      token.throwIfAborted();

      let base64;
      if (robust) {
        const { vec, region } = await robustVectorWholePage(tab.id, token, false);
        base64 = (await maybeRasterFallback(tab.id, token, settings, vec, region, true)).base64;
      } else {
        base64 = (await capturePdf(tab.id, token, { audit: false })).base64;
      }
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
