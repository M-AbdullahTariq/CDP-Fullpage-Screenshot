// PdfCapturer — turns a tab into a faithful PDF via CDP Page.printToPDF.
//
// Orchestrates the CDP session: enable screen-media emulation (so the capture
// looks like the browser, not the site's print stylesheet), read layout
// metrics, ask DimensionCalculator for paper size, then printToPDF as a single
// tall page — or paginated Letter output when the page is too tall to fit one.

import { withSession } from "./cdpSession.js";
import { calculate } from "./dimensionCalculator.js";
import { auditFrameTree } from "./frameAuditor.js";

/**
 * @param {number} tabId
 * @param {import("./cancellation.js").CancellationToken} [token]
 * @param {{ audit?: boolean, dims?: ({ paperWidthIn: number, paperHeightIn: number, paginate: boolean }|null) }} [options]
 * @returns {Promise<{ base64: string, paginated: boolean, audit: ({ total: number, sameOrigin: number, crossOrigin: number }|null) }>}
 */
export async function capturePdf(tabId, token, options = {}) {
  const { audit = false, dims: dimsOverride = null } = options;
  return withSession(
    tabId,
    async (session) => {
      token?.throwIfAborted();
      await session.send("Page.enable");

      // Render with screen media + backgrounds so colors/layout match the browser.
      await session.send("Emulation.setEmulatedMedia", { media: "screen" });

      // `dims` may be supplied by the caller (e.g. visible-part mode sizes the
      // page to the viewport); otherwise derive it from the full content metrics.
      let dims = dimsOverride;
      if (!dims) {
        const metrics = await session.send("Page.getLayoutMetrics");
        const content = metrics.cssContentSize || metrics.contentSize;
        const layout = metrics.cssLayoutViewport || metrics.layoutViewport || {};

        dims = calculate({
          contentWidthPx: content.width,
          contentHeightPx: content.height,
          windowInnerWidthPx: layout.clientWidth ?? content.width,
        });
      }

      // Optional iframe audit — best-effort, never fails the capture.
      let auditResult = null;
      if (audit) {
        try {
          const { frameTree } = await session.send("Page.getFrameTree");
          auditResult = auditFrameTree(frameTree);
        } catch {
          auditResult = null;
        }
      }

      const params = printOptions(dims);
      token?.throwIfAborted();
      const { data } = await session.send("Page.printToPDF", params);

      return { base64: data, paginated: dims.paginate, audit: auditResult };
    },
    token?.signal,
  );
}

/**
 * Build Page.printToPDF parameters from a DimensionCalculator result.
 * Single tall page: exact paper size, zero margins (full-bleed, screenshot-like),
 * clamped to `pageRanges: "1"` so a sub-pixel print-layout overflow can't spill
 * onto a trailing blank page.
 * Paginated fallback: Letter pages with Chrome's default print margins and the
 * full (unrestricted) page range.
 * @param {{ paperWidthIn: number, paperHeightIn: number, paginate: boolean }} dims
 */
export function printOptions(dims) {
  const base = {
    printBackground: true,
    scale: 1,
    landscape: false,
    preferCSSPageSize: false,
    paperWidth: dims.paperWidthIn,
    paperHeight: dims.paperHeightIn,
  };

  if (dims.paginate) {
    return base; // all pages, Chrome's default margins for a normal printout
  }

  return {
    ...base,
    marginTop: 0,
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    // The content fits one tall sheet; emit exactly page 1. Without this, a
    // fractional-inch overflow at print-layout time produces a blank page 2.
    pageRanges: "1",
  };
}
