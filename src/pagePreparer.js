// PagePreparer — pre-loads lazy content before capture.
//
// Injects a self-contained routine via chrome.scripting that step-scrolls to
// the bottom (triggering IntersectionObserver / scroll-driven lazy loading),
// waits for images to settle, then restores the original scroll position so
// the page looks untouched. Near-instant on pages that don't scroll.
//
// Cancellation is cooperative: the injected routine clears, then polls, a page
// global (window.__cdpFullPageCancel). preparePage sets that global by injecting
// a one-liner when the cancellation signal fires, so a long scroll stops promptly.
// The original scroll position is restored in a finally block either way.

/**
 * Runs in the PAGE. Must be fully self-contained (it is serialized and
 * injected), so all helpers live inside it and it closes over nothing.
 *
 * `enhanced` (Robust strategy) scrolls harder to coax virtualized / lazy lists into
 * fully materializing: a longer settle at each apparent bottom, a second full
 * top→bottom pass (content that mounts on a second viewing), and a longer image-decode
 * wait. Standard prep (enhanced falsey) keeps the original single-pass behavior.
 * @param {{ scrollSpeedMs?: number, maxScrollSteps?: number, maxScrollSeconds?: number, enhanced?: boolean }} [opts]
 * @returns {Promise<{ scrolled: boolean, finalHeight: number, cancelled: boolean }>}
 */
export function autoScrollInjected(opts) {
  return (async () => {
    const stepDelay = opts && opts.scrollSpeedMs > 0 ? opts.scrollSpeedMs : 120;
    const maxSteps = opts && opts.maxScrollSteps > 0 ? opts.maxScrollSteps : 400;
    const maxSeconds = opts && opts.maxScrollSeconds > 0 ? opts.maxScrollSeconds : 0;
    const enhanced = !!(opts && opts.enhanced);
    const settleMs = enhanced ? 300 : 150;
    const imageWaitMs = enhanced ? 3000 : 1500;
    const passes = enhanced ? 2 : 1;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const clock = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    const startTime = clock();
    // Wall-clock budget: stop once it's exceeded. 0 = no time cap.
    const timeUp = () => maxSeconds > 0 && clock() - startTime >= maxSeconds * 1000;
    const scroller = document.scrollingElement || document.documentElement;
    const startX = window.scrollX;
    const startY = window.scrollY;
    const viewport = window.innerHeight || 800;

    // Reset, then poll, the cooperative cancel flag set from the service worker.
    window.__cdpFullPageCancel = false;
    const cancelled = () => window.__cdpFullPageCancel === true;

    try {
      // Nothing to scroll — bail out fast.
      if (scroller.scrollHeight <= viewport + 1) {
        return { scrolled: false, finalHeight: scroller.scrollHeight, cancelled: false };
      }

      const step = Math.max(Math.floor(viewport * 0.9), 200);
      let steps = 0;

      // One or more full top→bottom passes (enhanced does a second pass to catch
      // content that only mounts the second time the viewport reaches it).
      for (let pass = 0; pass < passes; pass++) {
        if (pass > 0) {
          window.scrollTo({ top: 0, left: 0, behavior: "instant" });
          await sleep(settleMs);
        }
        for (let y = 0; ; y += step) {
          if (cancelled()) {
            return { scrolled: true, finalHeight: scroller.scrollHeight, cancelled: true };
          }
          window.scrollTo({ top: y, left: 0, behavior: "instant" });
          await sleep(stepDelay);

          const full = scroller.scrollHeight;
          if (y + viewport >= full) {
            // Looks like the bottom — settle, then stop only if it didn't grow.
            window.scrollTo({ top: full, left: 0, behavior: "instant" });
            await sleep(settleMs);
            if (scroller.scrollHeight <= full) break;
          }
          // Stop when either safeguard trips — whichever comes first. Bail all passes.
          if (++steps > maxSteps) {
            pass = passes;
            break;
          }
          if (timeUp()) {
            pass = passes;
            break;
          }
        }
      }

      if (cancelled()) {
        return { scrolled: true, finalHeight: scroller.scrollHeight, cancelled: true };
      }

      // Give any in-flight images a chance to decode (capped).
      const pending = Array.from(document.images).filter((im) => !im.complete);
      await Promise.race([
        Promise.all(pending.map((im) => im.decode().catch(() => {}))),
        sleep(imageWaitMs),
      ]);

      return { scrolled: true, finalHeight: scroller.scrollHeight, cancelled: false };
    } finally {
      // Always restore the user's scroll position, finished or cancelled.
      window.scrollTo({ top: startY, left: startX, behavior: "instant" });
    }
  })();
}

/**
 * Runs in the PAGE. Force every fixed/sticky element to `position: static` so it
 * flows inline once (matching the on-screen reading order) instead of floating,
 * repeating, or mispositioning when printToPDF lays out the whole document. Stashes
 * the prior inline `position` on a page global so restoreFixedStickyInjected can
 * revert it exactly. Self-contained.
 * @returns {{ neutralized: number }}
 */
export function neutralizeFixedStickyInjected() {
  const changed = [];
  for (const el of Array.from(document.querySelectorAll("*"))) {
    const pos = getComputedStyle(el).position;
    if (pos === "fixed" || pos === "sticky") {
      changed.push({
        el,
        value: el.style.getPropertyValue("position"),
        priority: el.style.getPropertyPriority("position"),
      });
      el.style.setProperty("position", "static", "important");
    }
  }
  window.__cdpHardened = (window.__cdpHardened || []).concat(changed);
  return { neutralized: changed.length };
}

/**
 * Runs in the PAGE. Undo neutralizeFixedStickyInjected exactly: restore each
 * element's prior inline `position` (and priority), then drop the stash.
 * @returns {void}
 */
export function restoreFixedStickyInjected() {
  const list = window.__cdpHardened;
  if (!list) return;
  for (const { el, value, priority } of list) {
    el.style.removeProperty("position");
    if (value) el.style.setProperty("position", value, priority || "");
  }
  delete window.__cdpHardened;
}

/**
 * Scroll the tab to pre-load lazy content, then restore scroll. Non-fatal:
 * if injection is blocked (restricted frame, etc.) capture proceeds as-is.
 * Honors `token` for cooperative cancellation while scrolling.
 * @param {number} tabId
 * @param {import("./cancellation.js").CancellationToken} [token]
 * @param {{ preCaptureDelayMs?: number, scrollSpeedMs?: number, maxScrollSteps?: number, maxScrollSeconds?: number }} [options]
 * @returns {Promise<void>}
 */
export async function preparePage(tabId, token, options = {}) {
  const { preCaptureDelayMs = 0, scrollSpeedMs, maxScrollSteps, maxScrollSeconds, enhanced = false } = options;
  let onAbort;
  try {
    if (token?.signal) {
      onAbort = () => signalInjectedCancel(tabId);
      if (token.signal.aborted) onAbort();
      else token.signal.addEventListener("abort", onAbort, { once: true });
    }
    // allFrames: scroll the top frame AND every same-origin sub-frame the
    // extension can reach, so lazy content inside iframes loads too. Each frame
    // scrolls its own window and restores itself. Cross-origin frames are
    // silently skipped by Chrome (no host permission) — they still paint into
    // the PDF if already loaded, but we can't drive their lazy loading.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: autoScrollInjected,
      args: [{ scrollSpeedMs, maxScrollSteps, maxScrollSeconds, enhanced }],
    });

    // Optional settle: give cross-origin embeds time to finish painting.
    if (preCaptureDelayMs > 0) {
      await abortableSleep(preCaptureDelayMs, token?.signal);
    }
  } catch (err) {
    console.warn(`PagePreparer: skipping pre-load (${err.message}).`);
  } finally {
    if (token?.signal && onAbort) token.signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Neutralize fixed/sticky positioning before a Robust vector capture. Applies in the
 * top frame and every reachable same-origin sub-frame. Persists until
 * restoreHardening — it must survive the capture itself, so it is NOT self-reverting.
 * Best-effort: a blocked frame is silently skipped.
 * @param {number} tabId
 */
export async function neutralizeFixedSticky(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: neutralizeFixedStickyInjected,
    });
  } catch {
    // Best-effort: if injection is blocked, the capture proceeds without hardening.
  }
}

/** Undo neutralizeFixedSticky after a capture. Best-effort — never throws. */
export async function restoreHardening(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: restoreFixedStickyInjected,
    });
  } catch {
    // Best-effort: leftover inline position:static is harmless if a restore is missed.
  }
}

/** Sleep `ms`, resolving early (not rejecting) if the signal aborts. */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Set the page's cooperative cancel flag so an in-progress auto-scroll stops. */
function signalInjectedCancel(tabId) {
  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        window.__cdpFullPageCancel = true;
      },
    })
    .catch(() => {});
}
