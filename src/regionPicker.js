// RegionPicker — rubber-band rectangle selector. A plain left-drag draws a live
// preview rectangle; on release the drawn rectangle (converted to DOCUMENT coords) is
// returned. Esc / right-click, or a too-small drag, cancels. The capture is clipped to
// exactly this rectangle, so a large element intersecting it can't expand the result.

/**
 * Runs in the PAGE. Resolves { picked, rect? } — rect in document coords (CSS px).
 * Self-contained.
 * @returns {Promise<{ picked: boolean, rect?: {left:number,top:number,width:number,height:number} }>}
 */
export function regionPickerInjected() {
  return new Promise((resolve) => {
    const prevCursor = document.documentElement.style.cursor;
    const prevUserSelect = document.documentElement.style.userSelect;
    document.documentElement.style.cursor = "crosshair";
    document.documentElement.style.userSelect = "none";

    const box = document.createElement("div");
    box.__cdpUi = true;
    Object.assign(box.style, {
      position: "fixed",
      zIndex: "2147483647",
      pointerEvents: "none",
      border: "2px dashed #1a73e8",
      background: "rgba(26,115,232,0.12)",
      boxSizing: "border-box",
      display: "none",
      top: "0",
      left: "0",
      width: "0",
      height: "0",
    });
    document.documentElement.appendChild(box);

    let startX = 0;
    let startY = 0;
    let dragging = false;

    const place = (x, y) => {
      box.style.left = Math.min(x, startX) + "px";
      box.style.top = Math.min(y, startY) + "px";
      box.style.width = Math.abs(x - startX) + "px";
      box.style.height = Math.abs(y - startY) + "px";
    };

    const down = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      box.style.display = "block";
      place(e.clientX, e.clientY);
    };
    const moveH = (e) => {
      if (!dragging) return;
      place(e.clientX, e.clientY);
    };
    const up = (e) => {
      if (!dragging) return;
      dragging = false;
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      if (w < 5 || h < 5) {
        cleanup(null); // treat a stray click / tiny drag as cancel
        return;
      }
      const left = Math.min(e.clientX, startX) + window.scrollX;
      const top = Math.min(e.clientY, startY) + window.scrollY;
      cleanup({ left, top, width: w, height: h });
    };
    const key = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cleanup(null);
      }
    };
    const ctx = (e) => {
      e.preventDefault();
      cleanup(null);
    };

    const cleanup = (rect) => {
      document.removeEventListener("mousedown", down, true);
      document.removeEventListener("mousemove", moveH, true);
      document.removeEventListener("mouseup", up, true);
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("contextmenu", ctx, true);
      box.remove();
      document.documentElement.style.cursor = prevCursor;
      document.documentElement.style.userSelect = prevUserSelect;
      delete window.__cdpPickAbort;
      resolve(rect ? { picked: true, rect } : { picked: false });
    };

    // Let the background dismiss the picker when Stop cancels the capture mid-pick.
    window.__cdpPickAbort = () => cleanup(null);

    document.addEventListener("mousedown", down, true);
    document.addEventListener("mousemove", moveH, true);
    document.addEventListener("mouseup", up, true);
    document.addEventListener("keydown", key, true);
    document.addEventListener("contextmenu", ctx, true);
  });
}

/** Runs in the PAGE. Dismiss an open picker (Stop pressed mid-pick). */
function abortPickInjected() {
  if (typeof window.__cdpPickAbort === "function") window.__cdpPickAbort();
}

/**
 * Run the region picker in the tab; resolves with the drawn rect (document coords)
 * or a cancel. If `signal` aborts (Stop) while the picker is open, it's dismissed
 * and resolves as a cancel.
 * @param {number} tabId
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ picked: boolean, rect?: object }>}
 */
export async function pickRegion(tabId, signal) {
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
      func: regionPickerInjected,
    });
    return res?.result ?? { picked: false };
  } catch {
    return { picked: false };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
