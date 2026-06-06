// Printability — heuristic decision for the Robust strategy: is this capture one that
// printToPDF renders badly (virtualized / infinite feed), so we should fall back to a
// raster screenshot?
//
// Detection can't be perfect. A false positive needlessly rasterizes a good capture
// (losing vector text + links); a false negative ships a broken vector PDF. We bias
// conservative: looksUnprintable returns true only on a strong signal — an explicit
// virtualization-library marker, or a very tall page carrying almost no live text
// (the tell-tale of a windowed list whose off-screen items aren't in the DOM). When
// unsure it returns false (keep vector). The caller always reports which path ran.
//
// Scope matters: the signals must match what's being captured. For a WHOLE-PAGE capture
// the page-level scrollHeight/density/markers apply. For a SUB-REGION capture (visible
// part, a picked element, the union, a drawn rect) the page being tall-and-sparse is
// irrelevant — what matters is whether the captured region itself sits inside a windowed
// container. So probePrintability takes the region (document coords; null = whole page):
// for a region it reports a virtualization marker only when one OVERLAPS the region, and
// drops the whole-page tall+sparse signal entirely. This stops a static element on an
// otherwise-virtualized page from being needlessly rasterized.

// A page taller than this many viewports counts as "tall".
export const TALL_VIEWPORT_MULTIPLE = 5;
// Live innerText characters per scroll-pixel below which a tall page looks sparse.
export const MIN_TEXT_DENSITY = 0.05;

/**
 * Decide whether a page's vector capture is likely unusable. Pure.
 * @param {{scrollHeight:number, viewportHeight:number, textLength:number, hasVirtualizationMarker:boolean}} signals
 * @returns {boolean}
 */
export function looksUnprintable(signals) {
  const s = signals || {};
  if (s.hasVirtualizationMarker) return true;
  const scrollHeight = Number(s.scrollHeight) || 0;
  const viewportHeight = Number(s.viewportHeight) || 0;
  const textLength = Number(s.textLength) || 0;
  if (!(scrollHeight > 0) || !(viewportHeight > 0)) return false;
  const tall = scrollHeight > viewportHeight * TALL_VIEWPORT_MULTIPLE;
  const density = textLength / scrollHeight;
  return tall && density < MIN_TEXT_DENSITY;
}

/**
 * Runs in the PAGE. Gather the signals looksUnprintable consumes, scoped to `region`.
 * `region` is null for a whole-page capture (use page-level signals) or a
 * {left,top,width,height} rect in DOCUMENT coords for a sub-region capture (report a
 * virtualization marker only when it overlaps the region, and drop the page-level
 * tall+sparse signal — a small region is never "tall and sparse"). Self-contained.
 * @param {{left:number,top:number,width:number,height:number}|null} region
 * @returns {{scrollHeight:number, viewportHeight:number, textLength:number, hasVirtualizationMarker:boolean}}
 */
export function probePrintabilityInjected(region) {
  // Containers a few popular windowing libraries render — a strong virtualization tell.
  const markers = [
    "[data-virtuoso-scroller]",
    "[data-testid='virtuoso-item-list']",
    ".ReactVirtualized__Grid",
    ".rc-virtual-list-holder",
    "[data-virtual-list]",
    ".ReactWindowList",
  ];

  // Does any virtualization container exist (whole page) / overlap the region (sub-region)?
  const overlapsRegion = (el) => {
    const r = el.getBoundingClientRect();
    const left = r.left + window.scrollX;
    const top = r.top + window.scrollY;
    return (
      left < region.left + region.width &&
      left + r.width > region.left &&
      top < region.top + region.height &&
      top + r.height > region.top
    );
  };
  let hasVirtualizationMarker = false;
  for (const sel of markers) {
    try {
      if (region) {
        for (const el of document.querySelectorAll(sel)) {
          if (overlapsRegion(el)) {
            hasVirtualizationMarker = true;
            break;
          }
        }
      } else if (document.querySelector(sel)) {
        hasVirtualizationMarker = true;
      }
      if (hasVirtualizationMarker) break;
    } catch {
      /* bad selector — ignore */
    }
  }

  // The tall+sparse signal is a whole-page tell; scope it out for sub-region captures
  // (zeroed scrollHeight makes looksUnprintable skip that branch and rely on the marker).
  if (region) {
    return { scrollHeight: 0, viewportHeight: 0, textLength: 0, hasVirtualizationMarker };
  }

  const de = document.scrollingElement || document.documentElement;
  const scrollHeight = de ? de.scrollHeight : 0;
  const viewportHeight = window.innerHeight || 0;
  let textLength = 0;
  try {
    textLength = document.body && document.body.innerText ? document.body.innerText.length : 0;
  } catch {
    textLength = 0;
  }
  return { scrollHeight, viewportHeight, textLength, hasVirtualizationMarker };
}

/**
 * Gather printability signals from the tab, scoped to `region` (null = whole page).
 * Best-effort defaults if injection fails.
 * @param {number} tabId
 * @param {{left:number,top:number,width:number,height:number}|null} [region]
 * @returns {Promise<{scrollHeight:number, viewportHeight:number, textLength:number, hasVirtualizationMarker:boolean}>}
 */
export async function probePrintability(tabId, region = null) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: probePrintabilityInjected,
      args: [region ?? null],
    });
    return res?.result ?? { scrollHeight: 0, viewportHeight: 0, textLength: 0, hasVirtualizationMarker: false };
  } catch {
    return { scrollHeight: 0, viewportHeight: 0, textLength: 0, hasVirtualizationMarker: false };
  }
}
