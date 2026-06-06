// TextLayerExtractor — collect selectable-text runs and link targets for the Robust
// raster fallback, so a screenshot-based PDF still selects/searches text and keeps
// links clickable (the invisible text + /URI layers built by imageToPdf).
//
// Coordinate contract: the caller passes `region` in DOCUMENT coordinates (CSS px,
// 0,0 = top-left of the full page content, scroll-independent) — the same space as a
// captureBeyondViewport screenshot clip. Returned boxes are translated to the clip's
// origin (top-left of `region`) and clipped to it, matching imageToPdf's CSS-px,
// y-down box space. Text granularity is run-level (one run per text node, full text +
// computed font size); per-glyph precision and non-Latin coverage are deferred.

/**
 * Runs in the PAGE. Walk text nodes and links within `region` (document coords),
 * returning runs/links in clip-origin space. Self-contained — closes over nothing.
 * @param {{left:number,top:number,width:number,height:number}} region
 * @returns {{ textRuns: Array<{text:string,box:object,fontSize:number}>, links: Array<{url:string,box:object}> }}
 */
export function extractInjected(region) {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const rx = region.left;
  const ry = region.top;
  const regionRight = rx + region.width;
  const regionBottom = ry + region.height;

  // A viewport client rect → document-space edges.
  const toDoc = (r) => ({
    left: r.left + scrollX,
    top: r.top + scrollY,
    right: r.right + scrollX,
    bottom: r.bottom + scrollY,
  });

  // Union of a node's client rects, in document space. null if it has no painted area.
  const unionDoc = (rects) => {
    let L = Infinity;
    let T = Infinity;
    let R = -Infinity;
    let B = -Infinity;
    for (const r of rects) {
      if (!(r.width > 0) || !(r.height > 0)) continue;
      const d = toDoc(r);
      if (d.left < L) L = d.left;
      if (d.top < T) T = d.top;
      if (d.right > R) R = d.right;
      if (d.bottom > B) B = d.bottom;
    }
    return R > L && B > T ? { left: L, top: T, right: R, bottom: B } : null;
  };

  const intersectsRegion = (d) =>
    d.left < regionRight && d.right > rx && d.top < regionBottom && d.bottom > ry;

  // Clip a document-space rect to the region and translate to the clip origin.
  const toClipBox = (d) => {
    const left = Math.max(d.left, rx);
    const top = Math.max(d.top, ry);
    const right = Math.min(d.right, regionRight);
    const bottom = Math.min(d.bottom, regionBottom);
    if (right <= left || bottom <= top) return null;
    return { left: left - rx, top: top - ry, width: right - left, height: bottom - top };
  };

  // --- text runs ---
  const textRuns = [];
  const root = document.body || document.documentElement;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
      const cs = getComputedStyle(p);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let node;
  while ((node = walker.nextNode())) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const doc = unionDoc(range.getClientRects());
    if (!doc || !intersectsRegion(doc)) continue;
    const box = toClipBox(doc);
    if (!box) continue;
    const cs = getComputedStyle(node.parentElement);
    const fontSize = parseFloat(cs.fontSize) || box.height;
    textRuns.push({ text: node.nodeValue.replace(/\s+/g, " ").trim(), box, fontSize });
  }

  // --- links ---
  const links = [];
  for (const a of Array.from(document.querySelectorAll("a[href]"))) {
    const url = a.href; // resolved to absolute by the DOM
    if (!url || url.indexOf("javascript:") === 0) continue;
    const doc = unionDoc(a.getClientRects());
    if (!doc || !intersectsRegion(doc)) continue;
    const box = toClipBox(doc);
    if (!box) continue;
    links.push({ url, box });
  }

  return { textRuns, links };
}

/**
 * Extract text runs + links within `region` (document coords) from the tab.
 * Best-effort: injection failures yield empty arrays so a capture never fails here.
 * @param {number} tabId
 * @param {{left:number,top:number,width:number,height:number}} region
 * @returns {Promise<{ textRuns: Array, links: Array }>}
 */
export async function extractTextAndLinks(tabId, region) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractInjected,
      args: [region],
    });
    return res?.result ?? { textRuns: [], links: [] };
  } catch {
    return { textRuns: [], links: [] };
  }
}
