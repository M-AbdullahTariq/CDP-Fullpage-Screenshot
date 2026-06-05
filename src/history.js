// History — record/list/clear past captures in chrome.storage.local.
//
// Entries are metadata only (no blobs):
//   { title, url, host, date, filename, ts }
// `date` is the human-readable string shown in the UI; `ts` is a sortable epoch
// ms recorded at capture time, used for accurate age comparison when pruning by
// the configured retention window. Re-open is delegated to chrome.downloads by
// the history page. The shape/merge/prune helpers below are Chrome-free so they
// can be unit-tested; the load/save wrappers touch chrome.storage.local.

import { loadSettings } from "./settings.js";

const STORAGE_KEY = "history";
const MAX_ENTRIES = 200; // cap so the list (and storage) can't grow unbounded
const DAY_MS = 86400000;

/** Derive the hostname from a URL, or "" if it can't be parsed. */
export function hostFromUrl(url) {
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

/**
 * Resolve a sortable epoch-ms timestamp for an entry. Prefers an explicit
 * numeric `ts`; otherwise derives one from the legacy `date` string
 * (YYYY-MM-DD) so old entries still prune accurately. Unparseable → 0 (treated
 * as oldest). Pure.
 */
function normalizeTs(ts, date) {
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) return ts;
  const parsed = date ? Date.parse(date) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Normalize raw capture metadata into a clean history entry. Pure.
 * Missing fields become empty strings; `host` is derived from `url` if absent;
 * `ts` is taken from the entry or derived from `date` (legacy migration).
 * @param {object} [raw]
 * @returns {{title:string,url:string,host:string,date:string,filename:string,ts:number}}
 */
export function makeEntry(raw = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const url = typeof r.url === "string" ? r.url : "";
  const date = typeof r.date === "string" ? r.date : "";
  return {
    title: typeof r.title === "string" ? r.title : "",
    url,
    host: typeof r.host === "string" && r.host ? r.host : hostFromUrl(url),
    date,
    filename: typeof r.filename === "string" ? r.filename : "",
    ts: normalizeTs(r.ts, date),
  };
}

/**
 * Prepend a new entry to the list (most-recent-first) and cap to `max`. Pure —
 * does not mutate `list`. Entries with no filename are dropped (nothing to
 * re-open).
 * @param {unknown} list  existing entries (may be malformed)
 * @param {object} entry  raw metadata for the new capture
 * @param {number} [max]
 */
export function addEntry(list, entry, max = MAX_ENTRIES) {
  const safe = normalizeHistory(list);
  const e = makeEntry(entry);
  if (!e.filename) return safe.slice(0, max);
  return [e, ...safe].slice(0, max);
}

/** Coerce stored data into a clean entry array (most-recent-first). Pure. */
export function normalizeHistory(stored) {
  if (!Array.isArray(stored)) return [];
  return stored.map(makeEntry).filter((e) => e.filename);
}

/**
 * Drop entries older than the retention window. `retentionDays === "all"` (or
 * any non-positive / non-finite value) is a no-op. Independent of the
 * max-entry cap. Pure — does not mutate `list`.
 * @param {unknown} list
 * @param {number|"all"} retentionDays
 * @param {number} now  epoch ms
 */
export function prune(list, retentionDays, now) {
  const safe = normalizeHistory(list);
  if (retentionDays === "all" || !Number.isFinite(retentionDays) || retentionDays <= 0) {
    return safe;
  }
  const cutoff = now - retentionDays * DAY_MS;
  return safe.filter((e) => e.ts >= cutoff);
}

// --- chrome.storage.local I/O ----------------------------------------------

/** Read the raw stored history value (may be malformed / undefined). */
async function readStored() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return got?.[STORAGE_KEY];
}

/**
 * Load the capture history (most-recent-first), cleaned of malformed rows and
 * pruned by the configured retention window. Persists the pruned list back when
 * entries were dropped, so opening the history page keeps storage current.
 */
export async function listHistory() {
  const { historyRetentionDays } = await loadSettings();
  const current = normalizeHistory(await readStored());
  const pruned = prune(current, historyRetentionDays, Date.now());
  if (pruned.length !== current.length) {
    await chrome.storage.local.set({ [STORAGE_KEY]: pruned });
  }
  return pruned;
}

/**
 * Record one capture. Best-effort: returns the new list. A missing filename is
 * a no-op (there'd be nothing to re-open). Prunes the retention window on write.
 * @param {object} raw {title,url,host,date,filename,ts}
 */
export async function recordCapture(raw) {
  const { historyRetentionDays } = await loadSettings();
  const added = addEntry(await readStored(), raw);
  const next = prune(added, historyRetentionDays, Date.now());
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}

/** Empty the history. */
export async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}
