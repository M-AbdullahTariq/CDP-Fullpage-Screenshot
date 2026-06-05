// DimensionCalculator — pure sizing decision for printToPDF. No Chrome APIs.
//
// Given the page's content size and the current window width, decides the PDF
// paper dimensions (in inches) and whether to fall back to paginated output
// when a single tall page would exceed Chrome's page-size cap.

export const PX_PER_INCH = 96;

// Chrome / PDF cap a single page at ~200 inches per side.
export const DEFAULT_CAP_INCHES = 200;

// Letter dimensions used for the pagination fallback.
export const LETTER_WIDTH_IN = 8.5;
export const LETTER_HEIGHT_IN = 11;

/**
 * Decide PDF paper dimensions for printToPDF.
 *
 * Single tall page: width = the current window's inner width (so responsive
 * layouts match the screen), height = the full content height. If that height
 * would exceed Chrome's per-page cap, fall back to paginated Letter output.
 *
 * @param {object} input
 * @param {number} input.contentWidthPx     full content width (CSS px)
 * @param {number} input.contentHeightPx    full content height (CSS px)
 * @param {number} input.windowInnerWidthPx current viewport width (CSS px)
 * @param {number} [input.capInches]        single-page size cap (default 200in)
 * @returns {{ paperWidthIn: number, paperHeightIn: number, paginate: boolean }}
 */
export function calculate(input) {
  const {
    contentWidthPx,
    contentHeightPx,
    windowInnerWidthPx,
    capInches = DEFAULT_CAP_INCHES,
  } = input ?? {};

  if (!(contentHeightPx > 0)) {
    throw new Error("DimensionCalculator: contentHeightPx must be a positive number.");
  }

  // Lay out at the window's inner width; fall back to content width if the
  // window width is unavailable. Round up to whole pixels so nothing is clipped.
  const layoutWidthPx = windowInnerWidthPx > 0 ? windowInnerWidthPx : contentWidthPx;
  if (!(layoutWidthPx > 0)) {
    throw new Error("DimensionCalculator: need a positive window or content width.");
  }

  const paperWidthIn = Math.ceil(layoutWidthPx) / PX_PER_INCH;
  const fullHeightIn = Math.ceil(contentHeightPx) / PX_PER_INCH;

  // A single page taller than the cap isn't representable; paginate instead.
  if (fullHeightIn > capInches) {
    return {
      paperWidthIn: LETTER_WIDTH_IN,
      paperHeightIn: LETTER_HEIGHT_IN,
      paginate: true,
    };
  }

  return {
    paperWidthIn,
    paperHeightIn: fullHeightIn,
    paginate: false,
  };
}
