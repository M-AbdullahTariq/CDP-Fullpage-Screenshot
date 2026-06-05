// FilenameTemplate — render a user filename template against capture tokens,
// then sanitize to a safe filename. Pure, Chrome-free, unit-testable.
//
// Tokens: {title} {host} {url} {date} {time} {year} {month} {day} {index}.
// Unknown tokens are left literal. The result has illegal filename characters
// and path separators stripped, whitespace collapsed, and length capped. The
// returned name has NO extension — the caller appends it (or uses buildOutputPath).

// Characters not allowed in filenames on common OSes, plus control chars.
// Spaces and hyphens are kept (legal and used by the default template).
const ILLEGAL = /[\\/:*?"<>|]/g;

/**
 * Make an arbitrary string safe to use as a filename (no extension).
 * @param {string} name
 * @param {string} [fallback]
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeFilename(name, fallback = "fullpage", maxLen = 150) {
  let s = String(name ?? "").replace(ILLEGAL, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/^[.\s]+|[.\s]+$/g, ""); // no leading/trailing dots or spaces
  if (s.length > maxLen) s = s.slice(0, maxLen).trim();
  return s || fallback;
}

/**
 * Zero-pad a 1-based index to `width`. Only pads plain non-negative integers;
 * width <= 0 (or falsy) returns the value unchanged. Pure.
 * @param {string|number} value
 * @param {number} [width]
 * @returns {string}
 */
export function padIndex(value, width = 0) {
  const s = String(value ?? "");
  if (!width || width <= 0) return s;
  return /^\d+$/.test(s) ? s.padStart(width, "0") : s;
}

/**
 * Render `template`, substituting {token} with `tokens[token]`. Unknown tokens
 * are left literal; null/undefined token values become empty strings. The
 * `{index}` token is zero-padded to `opts.padZeros` width (when non-empty). The
 * result is sanitized to a safe (extension-less) filename capped at opts.maxLen.
 * @param {string} template
 * @param {Record<string, string|number|undefined|null>} [tokens]
 * @param {{ maxLen?: number, padZeros?: number }} [opts]
 * @returns {string}
 */
export function render(template, tokens = {}, opts = {}) {
  const { maxLen = 150, padZeros = 0 } = opts;
  const tpl = String(template ?? "").trim() || "fullpage-{date}";
  const substituted = tpl.replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(tokens, key)) {
      const raw = tokens[key];
      let v = raw === undefined || raw === null ? "" : String(raw);
      if (key === "index" && v !== "") v = padIndex(v, padZeros);
      return v;
    }
    return match; // unknown token left literal
  });
  return sanitizeFilename(substituted, "fullpage", maxLen);
}

/**
 * Named filename presets for the settings UI. Each only FILLS the template
 * field — it does not change the persisted default (which stays "fullpage-{date}").
 * @type {ReadonlyArray<{ label: string, template: string }>}
 */
export const PRESETS = Object.freeze([
  { label: "Default (date)", template: "fullpage-{date}" },
  { label: "Default style", template: "Capture {index} - {title} - [{host}]" },
  { label: "Title + date", template: "{title}-{date}" },
  { label: "Host, date & time", template: "{host}-{date}-{time}" },
]);

/**
 * Assemble the relative output path passed to the downloader: an optional
 * (already-validated) Downloads-relative subfolder, the rendered base name, and
 * the extension. Pure — assumes `subfolder` is clean (see settings.validateSubfolder).
 * @param {string} base       sanitized base name (no extension)
 * @param {string} ext        extension without the dot, e.g. "pdf"
 * @param {string} [subfolder] forward-slash relative path, or ""
 * @returns {string}
 */
export function buildOutputPath(base, ext, subfolder = "") {
  const name = `${base}.${ext}`;
  return subfolder ? `${subfolder}/${name}` : name;
}
