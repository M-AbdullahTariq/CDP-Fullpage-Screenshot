import { parseUrlList } from "./src/urlList.js";

const urls = document.getElementById("urls");
const runBtn = document.getElementById("run");
const stopBtn = document.getElementById("stop");
const status = document.getElementById("status");

let running = false;

function setStatus(text, cls = "") {
  status.className = cls;
  status.textContent = text;
}

function toRunning() {
  running = true;
  runBtn.disabled = true;
  urls.disabled = true;
  stopBtn.hidden = false;
  stopBtn.disabled = false;
}

function toIdle(text, cls) {
  running = false;
  runBtn.disabled = false;
  urls.disabled = false;
  stopBtn.hidden = true;
  if (text !== undefined) setStatus(text, cls);
}

function summary(res) {
  const parts = [`${res.saved} saved`];
  if (res.failed) parts.push(`${res.failed} failed`);
  const head = res.cancelled ? "Stopped — " : "Done — ";
  return head + parts.join(", ") + ` of ${res.total}`;
}

runBtn.addEventListener("click", () => {
  const { urls: list, rejects } = parseUrlList(urls.value);
  if (list.length === 0) {
    setStatus("No valid URLs found.", "err");
    return;
  }

  toRunning();
  const note = rejects.length ? ` (${rejects.length} ignored)` : "";
  setStatus(`Capturing ${list.length} URL${list.length === 1 ? "" : "s"}${note}…`);

  chrome.runtime.sendMessage({ type: "RUN_BATCH", urls: list }, (res) => {
    if (chrome.runtime.lastError) {
      toIdle(chrome.runtime.lastError.message, "err");
      return;
    }
    if (res?.ok) toIdle(summary(res), res.failed ? "" : "ok");
    else if (res?.cancelled) toIdle("Cancelled.", "");
    else toIdle(res?.error || "Batch failed.", "err");
  });
});

stopBtn.addEventListener("click", () => {
  stopBtn.disabled = true;
  setStatus("Cancelling…");
  chrome.runtime.sendMessage({ type: "CANCEL_CAPTURE" }, () => {
    void chrome.runtime.lastError;
  });
});

// Live progress from the background loop.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "CAPTURE_PROGRESS" && running) {
    setStatus(`Capturing ${msg.current} of ${msg.total}: ${msg.title || ""}`);
  }
});
