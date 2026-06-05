// CancellationToken — a tiny, Chrome-free wrapper around AbortController.
//
// One capture = one token. The orchestrator holds the active token, the popup's
// Stop button triggers cancel(), and the token's signal threads through the
// pipeline (CDP session, capturer, page preparer) so work stops promptly and
// cleanly. Cancellation is surfaced as a CancelledError so it can be told apart
// from a real failure.

export class CancelledError extends Error {
  constructor(message = "Capture cancelled.") {
    super(message);
    this.name = "CancelledError";
    this.cancelled = true;
  }
}

export class CancellationToken {
  constructor() {
    this._controller = new AbortController();
  }

  /** The AbortSignal to hand to abort-aware APIs / event listeners. */
  get signal() {
    return this._controller.signal;
  }

  /** True once cancel() has been called. */
  get aborted() {
    return this._controller.signal.aborted;
  }

  /** Request cancellation. Idempotent — safe to call more than once. */
  cancel() {
    if (!this._controller.signal.aborted) {
      this._controller.abort();
    }
  }

  /** Throw a CancelledError if cancellation has been requested. */
  throwIfAborted() {
    if (this._controller.signal.aborted) {
      throw new CancelledError();
    }
  }
}

/** Was this error (or rejection) caused by a cancellation? */
export function isCancelled(err) {
  return (
    err instanceof CancelledError ||
    err?.cancelled === true ||
    err?.name === "CancelledError"
  );
}
