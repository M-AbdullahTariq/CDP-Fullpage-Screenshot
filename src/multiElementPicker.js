// MultiElementPicker — like the single-element picker, but builds a SET. Each plain
// click toggles the element under the cursor in/out of the selection (persistent red
// highlight + live count), Enter commits, Esc / right-click cancels. On commit the
// chosen elements are tagged data-cdp-selected="1" + data-cdp-index="N" in DOCUMENT
// order so the (separate) union isolation / per-element loop can find them.

/**
 * Runs in the PAGE. Resolves { picked, count } — picked true once the user presses
 * Enter with ≥1 element selected; false on cancel/empty. Self-contained.
 * @returns {Promise<{ picked: boolean, count: number }>}
 */
export function multiElementPickerInjected() {
  return new Promise((resolve) => {
    const prevCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";

    const selected = []; // elements, in click order
    const highlights = new Map(); // el -> highlight div

    const hover = document.createElement("div");
    hover.__cdpUi = true;
    Object.assign(hover.style, {
      position: "fixed",
      zIndex: "2147483646",
      pointerEvents: "none",
      border: "2px solid #1a73e8",
      background: "rgba(26,115,232,0.12)",
      boxSizing: "border-box",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
    });

    const badge = document.createElement("div");
    badge.__cdpUi = true;
    Object.assign(badge.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      top: "8px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#202124",
      color: "#fff",
      font: "12px system-ui, sans-serif",
      padding: "6px 10px",
      borderRadius: "6px",
    });
    const updateBadge = () => {
      badge.textContent = selected.length
        ? `${selected.length} selected — Enter to capture, Esc to cancel`
        : "Click elements to select — Esc to cancel";
    };
    updateBadge();

    document.documentElement.appendChild(hover);
    document.documentElement.appendChild(badge);

    const mkHighlight = () => {
      const d = document.createElement("div");
      d.__cdpUi = true;
      Object.assign(d.style, {
        position: "fixed",
        zIndex: "2147483645",
        pointerEvents: "none",
        border: "2px solid #ea4335",
        background: "rgba(234,67,53,0.15)",
        boxSizing: "border-box",
      });
      document.documentElement.appendChild(d);
      return d;
    };
    const place = (d, r) => {
      d.style.top = r.top + "px";
      d.style.left = r.left + "px";
      d.style.width = r.width + "px";
      d.style.height = r.height + "px";
    };
    // Highlights are fixed-positioned; reposition them as the page scrolls/resizes.
    const redraw = () => {
      for (const [el, d] of highlights) place(d, el.getBoundingClientRect());
    };

    let current = null;
    const move = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.__cdpUi) return;
      current = el;
      place(hover, el.getBoundingClientRect());
    };

    const click = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const el = current;
      if (!el || el.__cdpUi) return;
      const i = selected.indexOf(el);
      if (i >= 0) {
        selected.splice(i, 1);
        const d = highlights.get(el);
        if (d) d.remove();
        highlights.delete(el);
      } else {
        selected.push(el);
        const d = mkHighlight();
        highlights.set(el, d);
        place(d, el.getBoundingClientRect());
      }
      updateBadge();
    };

    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        cleanup(true);
      }
    };
    const ctx = (e) => {
      e.preventDefault();
      cleanup(false);
    };

    const cleanup = (commit) => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("contextmenu", ctx, true);
      window.removeEventListener("scroll", redraw, true);
      window.removeEventListener("resize", redraw, true);
      hover.remove();
      badge.remove();

      const picked = commit && selected.length > 0;
      const count = picked ? selected.length : 0;
      if (picked) {
        // Tag in document order so per-element output numbers predictably.
        const ordered = selected.slice().sort((a, b) =>
          a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
        );
        ordered.forEach((el, i) => {
          el.setAttribute("data-cdp-selected", "1");
          el.setAttribute("data-cdp-index", String(i));
        });
      }
      for (const [, d] of highlights) d.remove();
      highlights.clear();
      document.documentElement.style.cursor = prevCursor;
      delete window.__cdpPickAbort;
      resolve({ picked, count });
    };

    // Let the background dismiss the picker when Stop cancels the capture mid-pick.
    window.__cdpPickAbort = () => cleanup(false);

    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("contextmenu", ctx, true);
    window.addEventListener("scroll", redraw, true);
    window.addEventListener("resize", redraw, true);
  });
}

/** Runs in the PAGE. Dismiss an open picker (Stop pressed mid-pick). */
function abortPickInjected() {
  if (typeof window.__cdpPickAbort === "function") window.__cdpPickAbort();
}

/**
 * Run the multi-element picker in the tab; resolves when the user commits or cancels.
 * If `signal` aborts (Stop) while the picker is open, it's dismissed as a cancel.
 * @param {number} tabId
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ picked: boolean, count: number }>}
 */
export async function pickMultiElements(tabId, signal) {
  const onAbort = () => {
    chrome.scripting
      .executeScript({ target: { tabId }, func: abortPickInjected })
      .catch(() => {});
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: multiElementPickerInjected,
    });
    return res?.result ?? { picked: false, count: 0 };
  } catch {
    return { picked: false, count: 0 };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
