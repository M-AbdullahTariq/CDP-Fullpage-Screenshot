// CdpSession — promisified wrapper around chrome.debugger for one tab.
//
// Encapsulates attach / detach / sendCommand behind a small, stable interface so
// callers never touch chrome.runtime.lastError directly. Use `withSession` to
// guarantee the debugger detaches even when the body throws.

const PROTOCOL_VERSION = "1.3";

export class CdpSession {
  constructor(tabId) {
    this.target = { tabId };
    this.attached = false;
  }

  attach() {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach(this.target, PROTOCOL_VERSION, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          this.attached = true;
          resolve();
        }
      });
    });
  }

  detach() {
    return new Promise((resolve) => {
      if (!this.attached) {
        resolve();
        return;
      }
      chrome.debugger.detach(this.target, () => {
        // Ignore errors on detach — best effort cleanup.
        void chrome.runtime.lastError;
        this.attached = false;
        resolve();
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(this.target, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
  }
}

// Run `fn(session)` with an attached session, detaching afterward no matter what.
// If `signal` is provided and aborts, the debugger detaches immediately — which
// interrupts an in-flight command (e.g. Page.printToPDF) so cancellation is prompt.
export async function withSession(tabId, fn, signal) {
  const session = new CdpSession(tabId);
  await session.attach();

  const onAbort = () => {
    // Best-effort early detach; the body's send() then rejects and unwinds.
    void session.detach();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    return await fn(session);
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
    await session.detach(); // idempotent — no-op if already detached on abort
  }
}
