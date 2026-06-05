// DomIsolation — temporarily reshape the page so printToPDF (which has no clip
// and always renders the whole document from the top) yields a sub-region.
//
// Page.printToPDF can't clip, so to capture just the on-screen viewport we shift
// the document up by the current scroll offset (the visible region moves to the
// document origin), print a single viewport-tall page, then restore. The injected
// routines are self-contained; apply stashes what to undo on a window global so
// the later restore call (a separate injection) can revert it exactly.

/**
 * Runs in the PAGE. Shift the document so the current viewport sits at the
 * top-left, stashing the prior inline styles + scroll for restore. Returns the
 * viewport size (CSS px) used to size the PDF page.
 * @returns {{ width: number, height: number }}
 */
export function applyVisibleViewportInjected() {
  const doc = document.documentElement;
  const startX = window.scrollX;
  const startY = window.scrollY;
  const width = window.innerWidth || doc.clientWidth;
  const height = window.innerHeight || doc.clientHeight;

  window.__cdpVisible = {
    transform: doc.style.transform,
    transformOrigin: doc.style.transformOrigin,
    startX,
    startY,
  };

  // Move the visible region to the document origin so it becomes page 1.
  doc.style.transformOrigin = "top left";
  doc.style.transform = `translate(${-startX}px, ${-startY}px)`;

  return { width, height };
}

/**
 * Runs in the PAGE. Undo applyVisibleViewportInjected exactly.
 * @returns {void}
 */
export function restoreVisibleViewportInjected() {
  const doc = document.documentElement;
  const saved = window.__cdpVisible;
  if (!saved) return;
  doc.style.transform = saved.transform;
  doc.style.transformOrigin = saved.transformOrigin;
  window.scrollTo({ top: saved.startY, left: saved.startX, behavior: "instant" });
  delete window.__cdpVisible;
}

/**
 * Apply the visible-viewport transform and return its size. Throws if injection
 * is blocked (caller should surface a clear error).
 * @param {number} tabId
 * @returns {Promise<{ width: number, height: number }>}
 */
export async function applyVisibleViewport(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: applyVisibleViewportInjected,
  });
  return res?.result ?? { width: 0, height: 0 };
}

/** Restore the page after a visible capture. Best-effort — never throws. */
export async function restoreVisibleViewport(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreVisibleViewportInjected,
    });
  } catch {
    // Best-effort: the transform is inline and harmless if a restore is missed.
  }
}

// --- Selection (single element) ---------------------------------------------

/**
 * Runs in the PAGE. Isolate the element previously tagged data-cdp-selected:
 * hide every node not on its ancestor chain, then shift the document so the
 * element's top-left sits at the document origin. Stashes everything for an
 * exact restore. Returns the element's size (CSS px) for paper sizing.
 * @returns {{ ok: boolean, width?: number, height?: number }}
 */
export function isolateSelectedInjected() {
  const sel = document.querySelector('[data-cdp-selected="1"]');
  if (!sel) return { ok: false };

  // Everything on the path from the element up to <html> must stay visible.
  const keep = new Set();
  for (let n = sel; n; n = n.parentElement) keep.add(n);

  // Hide each off-path sibling along the ancestor chain.
  const hidden = [];
  for (let n = sel; n.parentElement; n = n.parentElement) {
    for (const child of Array.from(n.parentElement.children)) {
      if (!keep.has(child)) {
        hidden.push([child, child.style.display]);
        child.style.display = "none";
      }
    }
  }

  // Measure AFTER hiding (layout has reflowed), then translate to origin.
  const doc = document.documentElement;
  const rect = sel.getBoundingClientRect();
  const saved = {
    transform: doc.style.transform,
    transformOrigin: doc.style.transformOrigin,
    startX: window.scrollX,
    startY: window.scrollY,
  };
  doc.style.transformOrigin = "top left";
  doc.style.transform = `translate(${-rect.left}px, ${-rect.top}px)`;

  window.__cdpIsolated = { hidden, saved };
  return { ok: true, width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
}

/**
 * Runs in the PAGE. Undo isolateSelectedInjected exactly: unhide nodes, revert
 * the transform/scroll, and drop the selection marker.
 * @returns {void}
 */
export function restoreSelectedInjected() {
  const state = window.__cdpIsolated;
  if (state) {
    for (const [el, prevDisplay] of state.hidden) el.style.display = prevDisplay;
    const doc = document.documentElement;
    doc.style.transform = state.saved.transform;
    doc.style.transformOrigin = state.saved.transformOrigin;
    window.scrollTo({
      top: state.saved.startY,
      left: state.saved.startX,
      behavior: "instant",
    });
    delete window.__cdpIsolated;
  }
  const sel = document.querySelector('[data-cdp-selected="1"]');
  if (sel) sel.removeAttribute("data-cdp-selected");
}

/**
 * Isolate the tagged element and return its size for paper sizing.
 * @param {number} tabId
 * @returns {Promise<{ ok: boolean, width?: number, height?: number }>}
 */
export async function isolateSelected(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: isolateSelectedInjected,
  });
  return res?.result ?? { ok: false };
}

/** Restore the page after a selection capture. Best-effort — never throws. */
export async function restoreSelected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreSelectedInjected,
    });
  } catch {
    // Best-effort: leftover inline styles are harmless if a restore is missed.
  }
}
