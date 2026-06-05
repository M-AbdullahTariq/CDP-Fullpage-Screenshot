// FrameAuditor — classify a page's iframes by origin. Pure, Chrome-free.
//
// Given a CDP Page.getFrameTree result, count the sub-frames and split them into
// same-origin (the extension can inject + pre-scroll them) vs cross-origin
// (visual-only — painted if loaded, inner links never capturable). The top frame
// is the page itself and is not counted as an iframe.

/**
 * Parse the origin of a URL, or null when it has none (about:blank, srcdoc, …).
 * @param {string|undefined} url
 * @returns {string|null}
 */
export function originOf(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const origin = new URL(url).origin;
    // Opaque origins (about:blank, srcdoc, data:) serialize to "null" — report
    // null so callers treat them as inheriting the parent context.
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Count sub-frames and classify each by origin relative to the top frame.
 * Frames with no parseable origin (about:blank / srcdoc) inherit their parent
 * context, so they're treated as same-origin (driveable).
 * @param {object} frameTree  CDP Page.getFrameTree `frameTree` node
 * @param {string|null} topOrigin
 * @returns {{ total: number, sameOrigin: number, crossOrigin: number }}
 */
export function classifyFrames(frameTree, topOrigin) {
  let sameOrigin = 0;
  let crossOrigin = 0;

  const visit = (node, isTop) => {
    if (!node) return;
    if (!isTop) {
      const o = originOf(node.frame?.url);
      if (o === null || o === topOrigin) sameOrigin++;
      else crossOrigin++;
    }
    for (const child of node.childFrames || []) visit(child, false);
  };

  visit(frameTree, true);
  return { total: sameOrigin + crossOrigin, sameOrigin, crossOrigin };
}

/**
 * Convenience: derive the top origin from the tree itself, then classify.
 * @param {object} frameTree  CDP Page.getFrameTree `frameTree` node
 * @returns {{ total: number, sameOrigin: number, crossOrigin: number }}
 */
export function auditFrameTree(frameTree) {
  const topOrigin = originOf(frameTree?.frame?.url);
  return classifyFrames(frameTree, topOrigin);
}
