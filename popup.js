const modes = document.getElementById("modes");
const stopBtn = document.getElementById("stop");
const status = document.getElementById("status");
const gear = document.getElementById("gear");
const historyLink = document.getElementById("historyLink");

let capturing = false;

// --- Settings ---------------------------------------------------------------

// The gear opens the dedicated settings page (its own tab) instead of an inline
// panel — settings now apply only via that page's explicit Save.
gear.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  window.close();
});

// --- History ----------------------------------------------------------------

historyLink.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("history.html") });
  window.close();
});

// --- Status helpers ---------------------------------------------------------

/** Human-readable iframe summary appended to a successful capture status. */
function auditText(audit) {
  if (!audit) return "";
  if (audit.total === 0) return " — no iframes";
  const noun = audit.total === 1 ? "iframe" : "iframes";
  return (
    ` — ${audit.total} ${noun}: ` +
    `${audit.sameOrigin} same-origin, ` +
    `${audit.crossOrigin} cross-origin (visual only)`
  );
}

/** Summary line for a multi-capture run (all-tabs / batch). */
function multiSummary(res) {
  const parts = [`${res.saved} saved`];
  if (res.skippedInternal) parts.push(`${res.skippedInternal} skipped`);
  if (res.failed) parts.push(`${res.failed} failed`);
  const head = res.cancelled ? "Stopped — " : `${res.scope || "Captured"}: `;
  return head + parts.join(", ");
}

function setStatus(text, cls = "") {
  status.className = cls;
  status.textContent = text;
}

/** Show the mode menu (idle), optionally setting a status line. */
function toIdle(text, cls) {
  capturing = false;
  stopBtn.hidden = true;
  stopBtn.disabled = false;
  modes.hidden = false;
  if (text !== undefined) setStatus(text, cls);
}

/** Hide the menu, show Stop (busy). */
function toCapturing() {
  capturing = true;
  modes.hidden = true;
  stopBtn.hidden = false;
  stopBtn.disabled = false;
  setStatus("Capturing…");
}

// --- Mode menu --------------------------------------------------------------

modes.addEventListener("click", (e) => {
  const btn = e.target.closest(".mode");
  if (!btn || btn.disabled || capturing) return;
  startCapture(btn.dataset.mode);
});

function startCapture(mode) {
  // Batch isn't a one-shot capture — it opens its own page with a URL list.
  if (mode === "batch") {
    chrome.tabs.create({ url: chrome.runtime.getURL("batch.html") });
    window.close();
    return;
  }

  toCapturing();
  chrome.runtime.sendMessage({ type: "CAPTURE_FULL_PAGE", mode }, (res) => {
    if (chrome.runtime.lastError) {
      toIdle(chrome.runtime.lastError.message, "err");
      return;
    }
    if (res?.ok && res.multi) {
      toIdle(multiSummary(res), res.failed ? "" : "ok");
    } else if (res?.ok) {
      let base = `Saved: ${res.filename}`;
      if (res.paginated) base += " (paginated — page too tall for one sheet)";
      if (res.multiPage) base += " (multi-page)";
      // Robust strategy fell back to a screenshot: text is an invisible-but-selectable layer.
      if (res.fallback) base += " (image — text still selectable)";
      toIdle(base + auditText(res.audit), "ok");
    } else if (res?.cancelled) {
      toIdle("Cancelled.", "");
    } else {
      toIdle(res?.error || "Capture failed.", "err");
    }
  });
}

// --- Stop -------------------------------------------------------------------

stopBtn.addEventListener("click", () => {
  // Cancel; the in-flight capture callback above settles the UI.
  stopBtn.disabled = true;
  setStatus("Cancelling…");
  chrome.runtime.sendMessage({ type: "CANCEL_CAPTURE" }, () => {
    void chrome.runtime.lastError; // ignore: the capture response drives the UI
  });
});

// --- Progress (multi-capture) -----------------------------------------------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "CAPTURE_PROGRESS" && capturing) {
    const t = msg.title ? `: ${msg.title}` : "";
    setStatus(`Capturing ${msg.current} of ${msg.total}${t}`);
  }
});
