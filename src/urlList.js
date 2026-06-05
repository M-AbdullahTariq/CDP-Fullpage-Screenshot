// UrlList — parse a pasted blob into a clean list of capturable URLs. Pure,
// Chrome-free, unit-testable.
//
// Rules: split on newlines; trim; ignore blank lines and `#` comments; a line
// without a scheme is assumed https; only http(s) survive; duplicates are
// dropped (first wins); everything else is reported as a reject.

/**
 * @param {string} text
 * @returns {{ urls: string[], rejects: string[] }}
 */
export function parseUrlList(text) {
  const urls = [];
  const rejects = [];
  const seen = new Set();

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // Assume https:// when no scheme is present (e.g. "example.com/page").
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line : `https://${line}`;

    let url;
    try {
      url = new URL(candidate);
    } catch {
      rejects.push(line);
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      rejects.push(line);
      continue;
    }
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    urls.push(url.href);
  }

  return { urls, rejects };
}
