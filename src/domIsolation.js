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

// --- Selection (multiple elements: union) -----------------------------------

/**
 * Runs in the PAGE. Isolate every element tagged data-cdp-selected: keep visible the
 * union of all their ancestor chains, hide every off-chain sibling, then shift the
 * union bounding box to the document origin. Stashes everything for an exact restore.
 * Returns the union size (CSS px) for paper sizing.
 * @returns {{ ok: boolean, width?: number, height?: number }}
 */
export function isolateUnionInjected() {
  const sels = Array.from(document.querySelectorAll('[data-cdp-selected="1"]'));
  if (!sels.length) return { ok: false };

  // Keep visible: each selected element and all of its ancestors.
  const keep = new Set();
  for (const s of sels) {
    for (let n = s; n; n = n.parentElement) keep.add(n);
  }

  // Hide every child of a kept node that isn't itself kept (off-path siblings).
  // Process each parent once — multiple kept nodes can share a parent (e.g. two
  // picks under the same container), which would otherwise hide (and re-stash) the
  // same sibling twice, the second time capturing the already-"none" display.
  const hidden = [];
  const processedParents = new Set();
  for (const n of keep) {
    const p = n.parentElement;
    if (!p || processedParents.has(p)) continue;
    processedParents.add(p);
    for (const child of Array.from(p.children)) {
      if (!keep.has(child)) {
        hidden.push([child, child.style.display]);
        child.style.display = "none";
      }
    }
  }

  // Measure the union bounding box AFTER hiding (layout has reflowed).
  let L = Infinity;
  let T = Infinity;
  let R = -Infinity;
  let B = -Infinity;
  for (const s of sels) {
    const r = s.getBoundingClientRect();
    if (r.left < L) L = r.left;
    if (r.top < T) T = r.top;
    if (r.right > R) R = r.right;
    if (r.bottom > B) B = r.bottom;
  }

  const doc = document.documentElement;
  const saved = {
    transform: doc.style.transform,
    transformOrigin: doc.style.transformOrigin,
    startX: window.scrollX,
    startY: window.scrollY,
  };
  doc.style.transformOrigin = "top left";
  doc.style.transform = `translate(${-L}px, ${-T}px)`;

  window.__cdpUnion = { hidden, saved };
  return { ok: true, width: Math.ceil(R - L), height: Math.ceil(B - T) };
}

/**
 * Runs in the PAGE. Undo isolateUnionInjected exactly: unhide nodes, revert the
 * transform/scroll, and drop ALL selection markers + index attributes.
 * @returns {void}
 */
export function restoreUnionInjected() {
  const state = window.__cdpUnion;
  if (state) {
    for (const [el, prevDisplay] of state.hidden) el.style.display = prevDisplay;
    const doc = document.documentElement;
    doc.style.transform = state.saved.transform;
    doc.style.transformOrigin = state.saved.transformOrigin;
    window.scrollTo({ top: state.saved.startY, left: state.saved.startX, behavior: "instant" });
    delete window.__cdpUnion;
  }
  for (const el of Array.from(document.querySelectorAll('[data-cdp-selected="1"]'))) {
    el.removeAttribute("data-cdp-selected");
  }
  for (const el of Array.from(document.querySelectorAll("[data-cdp-index]"))) {
    el.removeAttribute("data-cdp-index");
  }
}

/**
 * Isolate the union of all tagged elements and return its size for paper sizing.
 * @param {number} tabId
 * @returns {Promise<{ ok: boolean, width?: number, height?: number }>}
 */
export async function isolateUnion(tabId) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: isolateUnionInjected,
  });
  return res?.result ?? { ok: false };
}

/** Restore the page after a union capture. Best-effort — never throws. */
export async function restoreUnion(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreUnionInjected,
    });
  } catch {
    // Best-effort: leftover inline styles/markers are harmless if a restore is missed.
  }
}

// --- Selection (one element of a multi-select, by index) --------------------

/**
 * Runs in the PAGE. Isolate the single multi-select element tagged
 * data-cdp-index="N" (hide off-chain siblings, shift its top-left to the origin),
 * WITHOUT touching the other selection markers — so a per-element / multi-page loop
 * can isolate each pick in turn. Stashes on a distinct global so the matching restore
 * reverts exactly this isolation and leaves the remaining markers intact. Returns the
 * element's size (CSS px) for paper sizing.
 * @param {number} index
 * @returns {{ ok: boolean, width?: number, height?: number }}
 */
export function isolateIndexInjected(index) {
  const sel = document.querySelector(`[data-cdp-index="${index}"]`);
  if (!sel) return { ok: false };

  const keep = new Set();
  for (let n = sel; n; n = n.parentElement) keep.add(n);

  const hidden = [];
  for (let n = sel; n.parentElement; n = n.parentElement) {
    for (const child of Array.from(n.parentElement.children)) {
      if (!keep.has(child)) {
        hidden.push([child, child.style.display]);
        child.style.display = "none";
      }
    }
  }

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

  window.__cdpOne = { hidden, saved };
  return { ok: true, width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
}

/**
 * Runs in the PAGE. Undo isolateIndexInjected exactly: unhide nodes and revert the
 * transform/scroll. Leaves all data-cdp-selected / data-cdp-index markers in place so
 * the next loop iteration can find them; clear them later via restoreUnion.
 * @returns {void}
 */
export function restoreIndexInjected() {
  const state = window.__cdpOne;
  if (!state) return;
  for (const [el, prevDisplay] of state.hidden) el.style.display = prevDisplay;
  const doc = document.documentElement;
  doc.style.transform = state.saved.transform;
  doc.style.transformOrigin = state.saved.transformOrigin;
  window.scrollTo({ top: state.saved.startY, left: state.saved.startX, behavior: "instant" });
  delete window.__cdpOne;
}

/**
 * Isolate one tagged element by index and return its size for paper sizing.
 * @param {number} tabId
 * @param {number} index
 * @returns {Promise<{ ok: boolean, width?: number, height?: number }>}
 */
export async function isolateIndex(tabId, index) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: isolateIndexInjected,
    args: [index],
  });
  return res?.result ?? { ok: false };
}

/** Restore the page after isolating one indexed element. Best-effort — never throws. */
export async function restoreIndex(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreIndexInjected,
    });
  } catch {
    // Best-effort: leftover inline styles are harmless if a restore is missed.
  }
}

// --- Region (arbitrary rectangle) -------------------------------------------

/**
 * Runs in the PAGE. Shift the document so the given rectangle's top-left sits at the
 * document origin (no hiding) — the visible-viewport trick for an arbitrary rect, so
 * printToPDF (which can't clip) yields just that region. `rect` is in document coords.
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @returns {{ width: number, height: number }}
 */
export function applyRegionShiftInjected(rect) {
  const doc = document.documentElement;
  window.__cdpRegion = {
    transform: doc.style.transform,
    transformOrigin: doc.style.transformOrigin,
    startX: window.scrollX,
    startY: window.scrollY,
  };
  doc.style.transformOrigin = "top left";
  doc.style.transform = `translate(${-rect.left}px, ${-rect.top}px)`;
  return { width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
}

/** Runs in the PAGE. Undo applyRegionShiftInjected exactly. */
export function restoreRegionInjected() {
  const saved = window.__cdpRegion;
  if (!saved) return;
  const doc = document.documentElement;
  doc.style.transform = saved.transform;
  doc.style.transformOrigin = saved.transformOrigin;
  window.scrollTo({ top: saved.startY, left: saved.startX, behavior: "instant" });
  delete window.__cdpRegion;
}

/**
 * Shift the document to the region rect and return its size for paper sizing.
 * @param {number} tabId
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @returns {Promise<{ width: number, height: number }>}
 */
export async function applyRegionShift(tabId, rect) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: applyRegionShiftInjected,
    args: [rect],
  });
  return res?.result ?? { width: 0, height: 0 };
}

/** Restore the page after a region capture. Best-effort — never throws. */
export async function restoreRegion(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: restoreRegionInjected,
    });
  } catch {
    // Best-effort: the transform is inline and harmless if a restore is missed.
  }
}
