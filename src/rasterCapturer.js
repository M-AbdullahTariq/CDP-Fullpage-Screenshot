// RasterCapturer — grab rendered pixels via CDP Page.captureScreenshot.
//
// The Robust-capture fallback: when printToPDF can't render a page, screenshot the
// actual pixels and hand them to imageToPdf for embedding. A clip rectangle (CSS px)
// bounds the capture; `scale` raises resolution (clip.scale) so a 2x shot stays crisp
// while still printing at 1x physical size. Full-page uses captureBeyondViewport with
// a clip covering the full content size from Page.getLayoutMetrics.

import { withSession } from "./cdpSession.js";

// Chrome rejects screenshots whose encoded dimension exceeds the max texture/canvas
// side. Guard so an enormous full-page feed fails with a clear, catchable error the
// orchestrator can fall back from, rather than an opaque CDP error.
const MAX_IMAGE_SIDE_PX = 0xffff; // 65535

/**
 * Capture rendered pixels of a tab (or a region of it) as a base64 image.
 * @param {number} tabId
 * @param {import("./cancellation.js").CancellationToken} [token]
 * @param {object} [options]
 * @param {{x?:number,y?:number,left?:number,top?:number,width:number,height:number}} [options.clip]
 *        Region to capture, in CSS px. Required unless `fullPage` is set.
 * @param {number} [options.scale=1]      resolution multiplier (1–3); higher = sharper/larger.
 * @param {"png"|"jpeg"} [options.format="png"]
 * @param {number} [options.quality=90]   JPEG quality (ignored for PNG).
 * @param {boolean} [options.fullPage=false] capture the full scrollable content.
 * @returns {Promise<{ base64: string, format: "png"|"jpeg", scale: number, cssWidth: number, cssHeight: number }>}
 */
export async function captureRaster(tabId, token, options = {}) {
  const { clip = null, scale = 1, format = "png", quality = 90, fullPage = false } = options;
  const imageFormat = format === "jpeg" ? "jpeg" : "png";

  return withSession(
    tabId,
    async (session) => {
      token?.throwIfAborted();
      await session.send("Page.enable");
      // Match the browser, not the site's print stylesheet (parity with pdfCapturer).
      await session.send("Emulation.setEmulatedMedia", { media: "screen" });

      // captureBeyondViewport interprets the clip in document coordinates (0,0 = page
      // top-left, scroll-independent) — the same space the text-layer extractor uses,
      // so a region screenshot and its text overlay line up regardless of scroll.
      const params = { format: imageFormat, captureBeyondViewport: true };
      if (imageFormat === "jpeg") params.quality = quality;

      // Resolve the clip rectangle (CSS px, document coords). Full-page derives it
      // from the full content size; otherwise the caller supplies a document-coord rect.
      let rect = clip
        ? { x: clip.x ?? clip.left ?? 0, y: clip.y ?? clip.top ?? 0, width: clip.width, height: clip.height }
        : null;
      if (fullPage) {
        const metrics = await session.send("Page.getLayoutMetrics");
        const content = metrics.cssContentSize || metrics.contentSize;
        rect = { x: 0, y: 0, width: content.width, height: content.height };
      }
      if (!rect || !(rect.width > 0 && rect.height > 0)) {
        throw new Error("captureRaster: a positive clip region (or fullPage) is required.");
      }

      // Reject images that would exceed Chrome's encode limit (caller can fall back).
      const sideW = Math.ceil(rect.width * scale);
      const sideH = Math.ceil(rect.height * scale);
      if (sideW > MAX_IMAGE_SIDE_PX || sideH > MAX_IMAGE_SIDE_PX) {
        throw new Error(
          `captureRaster: image ${sideW}x${sideH}px exceeds the ${MAX_IMAGE_SIDE_PX}px screenshot limit.`,
        );
      }

      params.clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale };

      token?.throwIfAborted();
      const { data } = await session.send("Page.captureScreenshot", params);
      return {
        base64: data,
        format: imageFormat,
        scale,
        cssWidth: rect.width,
        cssHeight: rect.height,
      };
    },
    token?.signal,
  );
}
