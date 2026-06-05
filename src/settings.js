// Settings — persisted capture preferences via chrome.storage.
//
// Numeric capture-tuning + toggles + output/workflow options. The
// merge/defaults/clamp logic is Chrome-free (mergeSettings, validateSubfolder)
// so it's testable without a browser; the thin load/save wrappers touch
// chrome.storage.local.

import { sanitizeFilename } from "./filenameTemplate.js";

export const DEFAULTS = Object.freeze({
  // Wait this long after pre-load (ms) so cross-origin embeds finish painting; 0 = off.
  preCaptureDelayMs: 400,
  // Pause between auto-scroll steps (ms) — slower lets lazy content load.
  scrollSpeedMs: 120,
  // Safety cap on auto-scroll steps (infinite-scroll pages).
  maxScrollSteps: 400,
  // Close the captured tab after saving.
  closeTabAfter: false,
  // Filename template (tokens applied at save time).
  filenameTemplate: "fullpage-{date}",
  // After capture, report how many iframes were present (same vs cross origin).
  frameAudit: false,
  // After saving, reveal the file (single) / Downloads folder (multi) in the OS.
  showInFolderAfterSave: false,
  // Path relative to Downloads that prefixes every saved file; "" = Downloads root.
  outputSubfolder: "",
  // Keep history entries this many days, or "all" for no expiry.
  historyRetentionDays: "all",
  // Zero-pad the {index} token / multi-capture -N suffix to this width; 0 = no padding.
  indexPadZeros: 3,
  // Cap the final filename length (characters).
  filenameMaxLen: 100,
  // All-tabs command captures each tab's visible viewport only (one page each).
  allTabsVisibleOnly: false,
  // Wall-clock cap (seconds) on the lazy-content pre-scroll; 0 = off.
  maxScrollSeconds: 0,
});

// Validation bounds for the numeric fields.
const BOUNDS = {
  preCaptureDelayMs: [0, 60000],
  scrollSpeedMs: [10, 5000],
  maxScrollSteps: [1, 10000],
  indexPadZeros: [0, 10],
  filenameMaxLen: [10, 255],
  maxScrollSeconds: [0, Infinity],
};

// Allowed history-retention windows (days). Anything else falls back to "all".
const RETENTION_DAYS = [7, 30, 90, 180, 365];

const STORAGE_KEY = "settings";

/** Coerce to a finite number in [min,max], falling back to `def`. */
function clampNum(value, def, [min, max]) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : def;
  return Math.min(max, Math.max(min, n));
}

/** Like clampNum, but rounds to an integer first. */
function clampInt(value, def, bounds) {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : def;
  return clampNum(n, def, bounds);
}

/** Pick a valid retention window, or "all" for anything unrecognized. */
function mergeRetention(value) {
  if (value === "all") return "all";
  if (typeof value === "number" && RETENTION_DAYS.includes(value)) return value;
  return DEFAULTS.historyRetentionDays;
}

/**
 * Validate/sanitize a Downloads-relative subfolder path. Pure.
 *
 * Rejects (→ "") absolute paths, drive letters, leading slashes, and any path
 * containing a `..` segment — these could escape Downloads. Otherwise sanitizes
 * each segment with the same illegal-char rules as filenames, drops empty / "."
 * segments, and collapses to "" when nothing valid remains.
 * @param {unknown} raw
 * @returns {string} a clean forward-slash relative path, or ""
 */
export function validateSubfolder(raw) {
  if (typeof raw !== "string") return "";
  const s = raw.trim().replace(/\\/g, "/"); // normalize backslashes to "/"
  if (!s) return "";
  // Reject absolute paths (leading slash) and drive letters / stray colons.
  if (s.startsWith("/") || /^[A-Za-z]:/.test(s) || s.includes(":")) return "";
  const segments = s.split("/");
  if (segments.some((seg) => seg === "..")) return ""; // no parent traversal
  return segments
    .map((seg) => sanitizeFilename(seg, "")) // "" fallback so empties stay empty
    .filter((seg) => seg && seg !== ".")
    .join("/");
}

/**
 * Merge a (possibly partial / malformed) stored object over the defaults,
 * coercing/clamping each known field. Pure — safe to unit-test. Unknown legacy
 * objects yield a fully valid config (new fields get defaults), so upgrades
 * migrate transparently with no reset.
 * @param {unknown} stored
 */
export function mergeSettings(stored) {
  const s = stored && typeof stored === "object" ? stored : {};
  return {
    preCaptureDelayMs: clampNum(s.preCaptureDelayMs, DEFAULTS.preCaptureDelayMs, BOUNDS.preCaptureDelayMs),
    scrollSpeedMs: clampNum(s.scrollSpeedMs, DEFAULTS.scrollSpeedMs, BOUNDS.scrollSpeedMs),
    maxScrollSteps: clampNum(s.maxScrollSteps, DEFAULTS.maxScrollSteps, BOUNDS.maxScrollSteps),
    closeTabAfter:
      typeof s.closeTabAfter === "boolean" ? s.closeTabAfter : DEFAULTS.closeTabAfter,
    filenameTemplate:
      typeof s.filenameTemplate === "string" && s.filenameTemplate.trim()
        ? s.filenameTemplate
        : DEFAULTS.filenameTemplate,
    frameAudit:
      typeof s.frameAudit === "boolean" ? s.frameAudit : DEFAULTS.frameAudit,
    showInFolderAfterSave:
      typeof s.showInFolderAfterSave === "boolean"
        ? s.showInFolderAfterSave
        : DEFAULTS.showInFolderAfterSave,
    outputSubfolder: validateSubfolder(s.outputSubfolder),
    historyRetentionDays: mergeRetention(s.historyRetentionDays),
    indexPadZeros: clampInt(s.indexPadZeros, DEFAULTS.indexPadZeros, BOUNDS.indexPadZeros),
    filenameMaxLen: clampInt(s.filenameMaxLen, DEFAULTS.filenameMaxLen, BOUNDS.filenameMaxLen),
    allTabsVisibleOnly:
      typeof s.allTabsVisibleOnly === "boolean"
        ? s.allTabsVisibleOnly
        : DEFAULTS.allTabsVisibleOnly,
    maxScrollSeconds: clampNum(s.maxScrollSeconds, DEFAULTS.maxScrollSeconds, BOUNDS.maxScrollSeconds),
  };
}

/** Load current settings, merged over defaults. */
export async function loadSettings() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return mergeSettings(got?.[STORAGE_KEY]);
}

/**
 * Apply a partial update and persist. Returns the full, merged settings.
 * @param {object} patch
 */
export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = mergeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  return next;
}
