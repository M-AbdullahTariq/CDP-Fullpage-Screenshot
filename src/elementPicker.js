// ElementPicker — devtools-style "click an element" overlay, injected into the
// page. Highlights the element under the cursor on hover, selects it on click,
// cancels on Escape / right-click. The chosen element is marked with a data
// attribute so the (separate) isolation step can find it.

/**
 * Runs in the PAGE. Resolves to { picked: true } once the user clicks an
 * element (which is tagged with data-cdp-selected), or { picked: false } if
 * they cancel. Self-contained — closes over nothing.
 * @returns {Promise<{ picked: boolean }>}
 */
export function elementPickerInjected() {
  return new Promise((resolve) => {
    let current = null;
    const prevCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      border: "2px solid #1a73e8",
      background: "rgba(26,115,232,0.12)",
      borderRadius: "2px",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
      boxSizing: "border-box",
      transition: "top 40ms ease, left 40ms ease, width 40ms ease, height 40ms ease",
    });
    document.documentElement.appendChild(overlay);

    const move = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el === overlay) return;
      current = el;
      const r = el.getBoundingClientRect();
      overlay.style.top = r.top + "px";
      overlay.style.left = r.left + "px";
      overlay.style.width = r.width + "px";
      overlay.style.height = r.height + "px";
    };

    const cleanup = (result) => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("contextmenu", ctx, true);
      overlay.remove();
      document.documentElement.style.cursor = prevCursor;
      delete window.__cdpPickAbort;
      resolve(result);
    };

    // Let the background dismiss the picker when the Stop button cancels the capture
    // mid-pick (the picker otherwise blocks until the user clicks/Escapes).
    window.__cdpPickAbort = () => cleanup({ picked: false });

    const click = (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (current) {
        current.setAttribute("data-cdp-selected", "1");
        cleanup({ picked: true });
      } else {
        cleanup({ picked: false });
      }
    };
    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup({ picked: false });
      }
    };
    const ctx = (e) => {
      e.preventDefault();
      cleanup({ picked: false });
    };

    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("contextmenu", ctx, true);
  });
}

/** Runs in the PAGE. Dismiss an open picker (Stop pressed mid-pick). */
function abortPickInjected() {
  if (typeof window.__cdpPickAbort === "function") window.__cdpPickAbort();
}

/**
 * Run the element picker in the tab; resolves when the user picks or cancels. If
 * `signal` aborts (Stop) while the picker is open, the picker is dismissed and
 * resolves as a cancel.
 * @param {number} tabId
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ picked: boolean }>}
 */
export async function pickElement(tabId, signal) {
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
      func: elementPickerInjected,
    });
    return res?.result ?? { picked: false };
  } catch {
    return { picked: false };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
