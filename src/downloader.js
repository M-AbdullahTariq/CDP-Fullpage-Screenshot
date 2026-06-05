// Downloader — filename generation + chrome.downloads.
//
// IMPORTANT: chrome.downloads.download()'s `filename` option is unreliable —
// for data: URLs, and when another installed extension registers an
// onDeterminingFilename listener, Chrome ignores it and falls back to its own
// default ("download.<sniffed-ext>"). The reliable mechanism is to register our
// OWN chrome.downloads.onDeterminingFilename listener and suggest() the name.
// We do both: pass `filename` AND suggest it from the listener (the guarantee).

import { buildOutputPath } from "./filenameTemplate.js";

// The filename to apply to the next download we initiate. Captures are
// sequential (each awaited), so a single slot is race-free.
let pendingName = null;

// Register the determining-filename hook once, at module load (runs on every
// service-worker wake). It only touches downloads WE initiated.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const ours = item.byExtensionId === chrome.runtime.id;
  if (ours && pendingName) {
    const name = pendingName;
    pendingName = null;
    suggest({ filename: name, conflictAction: "uniquify" });
    return;
  }
  suggest(); // not ours / nothing pending — let Chrome (or others) decide
});

/**
 * Build a timestamped filename like `fullpage-2026-06-02T12-00-00-000Z.ext`,
 * with an optional `-N` index to keep multi-capture runs (all-tabs/batch) unique.
 * @param {string} ext  extension without the dot, e.g. "pdf"
 * @param {number} [index]  1-based index appended as `-N` when provided
 * @returns {string}
 */
export function timestampedFilename(ext, index) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = index ? `-${index}` : "";
  return `fullpage-${stamp}${suffix}.${ext}`;
}

/**
 * Download a base64 payload as a file via a data URL.
 * @param {object} input
 * @param {string} input.base64    base64-encoded file contents
 * @param {string} input.mimeType  e.g. "application/pdf"
 * @param {string} input.ext       extension without the dot
 * @param {string} [input.filename] base name without extension (from a template);
 *                                   falls back to a timestamped name when absent
 * @param {number} [input.index]   1-based index for the timestamped fallback
 * @param {string} [input.subfolder] validated Downloads-relative subfolder, or ""
 * @returns {Promise<{filename: string, downloadId: number}>} the path used + download id
 */
export async function download({ base64, mimeType, ext, filename, index, subfolder = "" }) {
  const fallback = timestampedFilename(ext, index);
  const name = filename
    ? buildOutputPath(filename, ext, subfolder)
    : subfolder
      ? `${subfolder}/${fallback}`
      : fallback;
  pendingName = name; // consumed by the onDeterminingFilename listener above
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: `data:${mimeType};base64,${base64}`,
      filename: name,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } catch (err) {
    pendingName = null; // download never started; don't leak to the next one
    throw err;
  }
  return { filename: name, downloadId };
}
