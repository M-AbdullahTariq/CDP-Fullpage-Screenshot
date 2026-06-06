// Geometry — pure rectangle math (union, intersect, clip, scale).
//
// NOTE: these helpers are currently UNUSED. The rect math they cover (union bbox,
// intersection, clip-to-region, px scaling) ended up inlined inside the page-injected
// routines that need it — the union in `domIsolation`/`background.measureUnionInjected`,
// the clip/union in `textLayerExtractor` — and injected functions are serialized into
// the page and cannot `import` an ES module, so they can't call into here. This module
// is kept as a Chrome-free, unit-testable home for that math; wire the injected callers
// to return raw rects and fold here, or remove it (see README / code-review notes).
//
// Rectangles are plain { top, left, width, height } objects in whatever coordinate
// space the caller is working in (CSS px, screenshot px, …). Chrome-free, no DOM —
// `getBoundingClientRect()` results satisfy this shape directly. Right/bottom edges
// are derived internally so callers never have to keep them in sync.

/** Right/bottom edges of a { top, left, width, height } rect. */
function edges(r) {
  return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height };
}

/**
 * Bounding box enclosing every rect in `rects`. Returns null for an empty list so
 * the caller can decide what "nothing selected" means.
 * @param {Array<{top:number,left:number,width:number,height:number}>} rects
 * @returns {{top:number,left:number,width:number,height:number}|null}
 */
export function unionRect(rects) {
  if (!Array.isArray(rects) || rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    const e = edges(r);
    if (e.left < left) left = e.left;
    if (e.top < top) top = e.top;
    if (e.right > right) right = e.right;
    if (e.bottom > bottom) bottom = e.bottom;
  }
  return { top, left, width: right - left, height: bottom - top };
}

/**
 * Whether two rects overlap. Inclusive of edge-touch (a shared border counts as an
 * intersection) — well-suited to the region picker's "is this element under the
 * rubber-band?" highlight test.
 * @returns {boolean}
 */
export function rectsIntersect(a, b) {
  const ea = edges(a);
  const eb = edges(b);
  return ea.left <= eb.right && eb.left <= ea.right && ea.top <= eb.bottom && eb.top <= ea.bottom;
}

/**
 * Clamp `inner` to the area inside `bounds`. Returns the overlapping rectangle, or
 * null when they don't overlap (so a region capture never produces a negative or
 * empty clip). Used to keep a region capture pinned to the drawn rectangle no
 * matter how large an intersecting element is.
 * @returns {{top:number,left:number,width:number,height:number}|null}
 */
export function clipRectToRect(inner, bounds) {
  const ei = edges(inner);
  const eb = edges(bounds);
  const left = Math.max(ei.left, eb.left);
  const top = Math.max(ei.top, eb.top);
  const right = Math.min(ei.right, eb.right);
  const bottom = Math.min(ei.bottom, eb.bottom);
  if (right <= left || bottom <= top) return null;
  return { top, left, width: right - left, height: bottom - top };
}

/**
 * Scale every coordinate of a rect by `factor` — converts CSS-px boxes into the
 * screenshot's pixel space when a raster capture uses a resolution scale > 1.
 * @returns {{top:number,left:number,width:number,height:number}}
 */
export function scaleRect(rect, factor) {
  return {
    top: rect.top * factor,
    left: rect.left * factor,
    width: rect.width * factor,
    height: rect.height * factor,
  };
}
