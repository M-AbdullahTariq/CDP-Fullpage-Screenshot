// PdfMerge — combine several single-page PDFs into one multi-page PDF.
//
// The Multi-select "one multi-page PDF" output (Standard strategy) captures each
// picked element as its own printToPDF document, then merges them here so the
// result is a single file with true selectable vector text per page.
//
// Pure: PDF bytes/base64 in, merged PDF bytes/base64 out — no Chrome, no DOM. The
// inputs are Chrome `Page.printToPDF` outputs, which use a classic cross-reference
// table and no object streams; this merger relies on that shape:
//   • objects are scanned directly as `N G obj … endobj` (xref offsets ignored, so a
//     stale/odd xref can't break us); stream bodies are skipped via /Length (falling
//     back to an `endstream` search) so binary data is never mistaken for structure;
//   • each source's objects are renumbered onto a shared id space, indirect references
//     rewritten — but only in the dictionary portion of each object, never in stream
//     bytes, so compressed content is copied verbatim;
//   • the page tree + catalog are rebuilt fresh: every leaf /Page is copied, its
//     /Parent repointed to the new /Pages node (with an inherited /MediaBox injected if
//     the leaf lacked its own). Intermediate /Pages nodes and source catalogs are dropped.
//
// Anything that doesn't fit (encrypted, object streams, no parseable pages) throws —
// the caller is expected to fall back to a raster multi-page PDF.

/** Decode base64 → binary (latin1) string, where each char code is one byte. */
function base64ToBinary(b64) {
  if (typeof atob !== "undefined") return atob(b64);
  return Buffer.from(b64, "base64").toString("binary");
}

/** Encode a binary (latin1) string → base64. */
function binaryToBase64(bin) {
  if (typeof btoa !== "undefined") return btoa(bin);
  return Buffer.from(bin, "binary").toString("base64");
}

/** Coerce a PDF input (base64 string or Uint8Array) to a binary (latin1) string. */
function toBinaryString(input) {
  if (typeof input === "string") return base64ToBinary(input);
  if (input instanceof Uint8Array) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < input.length; i += chunk) {
      s += String.fromCharCode.apply(null, input.subarray(i, i + chunk));
    }
    return s;
  }
  throw new Error("pdfMerge: input must be a base64 string or Uint8Array.");
}

/** The dictionary portion of an object body — everything before its `stream` keyword. */
function dictPart(body) {
  const i = body.indexOf("stream");
  return i === -1 ? body : body.slice(0, i);
}

/**
 * Find where a stream object's data ends. Trusts a direct `/Length N` when present
 * and consistent (endstream follows), otherwise searches for `endstream`. Returns the
 * index of `endstream`'s start, or -1 if none.
 */
function findEndstream(str, dict, dataStart) {
  // Indirect length (`/Length 5 0 R`) can't be trusted inline — search instead.
  if (!/\/Length\s+\d+\s+\d+\s+R/.test(dict)) {
    const m = /\/Length\s+(\d+)(?:\s|\/|>|\])/.exec(dict);
    if (m) {
      const cand = dataStart + Number(m[1]);
      if (/^\s*endstream/.test(str.substr(cand, 24))) return cand + str.substr(cand, 24).indexOf("endstream");
    }
  }
  return str.indexOf("endstream", dataStart);
}

/**
 * Scan a PDF for its top-level objects. Returns a Map of object number → { body },
 * where `body` is the text strictly between the `obj` keyword and its `endobj`.
 * Stream interiors are skipped so binary data is never re-scanned as structure.
 */
function parseObjects(str) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj/g;
  let m;
  while ((m = re.exec(str))) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;

    const streamIdx = str.indexOf("stream", bodyStart);
    let endobjIdx = str.indexOf("endobj", bodyStart);
    if (endobjIdx === -1) throw new Error("pdfMerge: object missing endobj.");

    // Stream object: jump past the binary payload before locating endobj.
    if (streamIdx !== -1 && streamIdx < endobjIdx) {
      const dict = str.slice(bodyStart, streamIdx);
      let dataStart = streamIdx + "stream".length;
      if (str[dataStart] === "\r") dataStart++;
      if (str[dataStart] === "\n") dataStart++;
      const endStream = findEndstream(str, dict, dataStart);
      if (endStream === -1) throw new Error("pdfMerge: stream missing endstream.");
      endobjIdx = str.indexOf("endobj", endStream);
      if (endobjIdx === -1) throw new Error("pdfMerge: stream object missing endobj.");
    }

    objs.set(num, { body: str.slice(bodyStart, endobjIdx) });
    re.lastIndex = endobjIdx + "endobj".length;
  }
  if (!objs.size) throw new Error("pdfMerge: no objects found (encrypted or object streams?).");
  return objs;
}

/** Parse `/Key N G R` from a dictionary string → { num, gen } or null. */
function refValue(dict, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`).exec(dict);
  return m ? { num: Number(m[1]), gen: Number(m[2]) } : null;
}

/** Parse the `/Kids [ … ]` array of a /Pages node → list of { num, gen }. */
function parseKids(dict) {
  const m = /\/Kids\s*\[([^\]]*)\]/.exec(dict);
  if (!m) return [];
  const refs = [];
  const re = /(\d+)\s+(\d+)\s+R/g;
  let r;
  while ((r = re.exec(m[1]))) refs.push({ num: Number(r[1]), gen: Number(r[2]) });
  return refs;
}

/** Find the object number of the document Catalog by /Type, or null. */
function findCatalog(objs) {
  for (const [num, obj] of objs) {
    if (/\/Type\s*\/Catalog\b/.test(dictPart(obj.body))) return num;
  }
  return null;
}

/**
 * Walk a source's page tree from `rootNum`, collecting leaf /Page object numbers in
 * order and recording every intermediate /Pages node number (to skip when copying).
 */
function walkPages(objs, rootNum) {
  const pageNums = [];
  const pagesNodes = new Set();
  const seen = new Set();
  const visit = (num) => {
    if (seen.has(num)) return;
    seen.add(num);
    const obj = objs.get(num);
    if (!obj) return;
    const d = dictPart(obj.body);
    const kids = parseKids(d);
    if (/\/Type\s*\/Pages\b/.test(d) || (kids.length && !/\/Type\s*\/Page\b/.test(d))) {
      pagesNodes.add(num);
      for (const k of kids) visit(k.num);
    } else if (/\/Type\s*\/Page\b/.test(d)) {
      pageNums.push(num);
    }
  };
  visit(rootNum);
  return { pageNums, pagesNodes };
}

/** Parse one source PDF into the structure the assembler needs. Throws if unusable. */
function parseSource(input) {
  const str = toBinaryString(input);
  if (str.indexOf("%PDF-") === -1) throw new Error("pdfMerge: not a PDF.");
  if (/\/Encrypt\b/.test(str)) throw new Error("pdfMerge: encrypted PDFs unsupported.");
  const objs = parseObjects(str);
  const catalogNum = findCatalog(objs);
  if (catalogNum == null) throw new Error("pdfMerge: no Catalog found.");
  const rootRef = refValue(dictPart(objs.get(catalogNum).body), "Pages");
  if (!rootRef) throw new Error("pdfMerge: Catalog has no /Pages.");
  const { pageNums, pagesNodes } = walkPages(objs, rootRef.num);
  if (!pageNums.length) throw new Error("pdfMerge: no pages found.");
  // Inheritable MediaBox from the root pages node, for any leaf that omits its own.
  const rootMediaBox = /\/MediaBox\s*\[[^\]]*\]/.exec(dictPart(objs.get(rootRef.num).body))?.[0] ?? null;
  return { objs, pageNums, pagesNodes, catalogNum, rootMediaBox };
}

/** Rewrite every indirect reference in a dictionary string using an old→new id map. */
function rewriteRefs(text, map) {
  return text.replace(/(\d+)\s+(\d+)\s+R/g, (full, n, g) => (map.has(Number(n)) ? `${map.get(Number(n))} ${g} R` : full));
}

/**
 * Rewrite references in an object body, leaving stream bytes untouched (refs only
 * occur in the dictionary, and binary data must be copied verbatim).
 */
function rewriteObj(body, map) {
  const i = body.indexOf("stream");
  if (i === -1) return rewriteRefs(body, map);
  return rewriteRefs(body.slice(0, i), map) + body.slice(i);
}

/** Repoint a leaf page's /Parent to the new Pages node id (inject if absent). */
function setParent(body, pagesId) {
  if (/\/Parent\s+\d+\s+\d+\s+R/.test(body)) {
    return body.replace(/\/Parent\s+\d+\s+\d+\s+R/, `/Parent ${pagesId} 0 R`);
  }
  return body.replace("<<", `<< /Parent ${pagesId} 0 R`);
}

/** Ensure a leaf page carries a /MediaBox, injecting the inherited one if missing. */
function ensureMediaBox(body, rootMediaBox) {
  if (/\/MediaBox\s*\[/.test(body) || !rootMediaBox) return body;
  return body.replace("<<", `<< ${rootMediaBox}`);
}

/** Serialize collected objects + a fresh catalog/pages tree into PDF bytes (latin1 string). */
function serialize(outObjects, catalogId, pagesId, pageIds, size) {
  const all = [
    { id: catalogId, body: `\n<< /Type /Catalog /Pages ${pagesId} 0 R >>\n` },
    {
      id: pagesId,
      body: `\n<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>\n`,
    },
    ...outObjects,
  ].sort((a, b) => a.id - b.id);

  let out = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"; // binary marker so tools treat it as binary
  const offsets = new Array(size).fill(0);
  for (const o of all) {
    offsets[o.id] = out.length;
    out += `${o.id} 0 obj${o.body}endobj\n`;
  }

  const xrefOffset = out.length;
  out += `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let id = 1; id < size; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${size} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return out;
}

/**
 * Merge single/multi-page PDFs into one multi-page PDF (latin1 binary string).
 * @param {Array<string|Uint8Array>} inputs  base64 strings or raw bytes, in page order
 * @returns {string} merged PDF as a binary (latin1) string
 */
function mergeToBinary(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("pdfMerge: need at least one input PDF.");
  }
  const sources = inputs.map(parseSource);

  const catalogId = 1;
  const pagesId = 2;
  let nextId = 3;
  const outObjects = [];
  const pageIds = [];

  for (const src of sources) {
    // Copy every object except this source's Catalog and its /Pages-tree nodes; the
    // leaf /Page objects ARE copied. Stable numeric order → deterministic output.
    const copyNums = [...src.objs.keys()]
      .filter((n) => n !== src.catalogNum && !src.pagesNodes.has(n))
      .sort((a, b) => a - b);

    const map = new Map();
    for (const n of copyNums) map.set(n, nextId++);

    const leaves = new Set(src.pageNums);
    for (const n of copyNums) {
      let body = rewriteObj(src.objs.get(n).body, map);
      if (leaves.has(n)) {
        body = setParent(body, pagesId);
        body = ensureMediaBox(body, src.rootMediaBox);
      }
      outObjects.push({ id: map.get(n), body });
    }
    // Page order follows the source's page tree, not object numbering.
    for (const pn of src.pageNums) pageIds.push(map.get(pn));
  }

  return serialize(outObjects, catalogId, pagesId, pageIds, nextId);
}

/**
 * Merge PDFs into one multi-page PDF and return raw bytes.
 * @param {Array<string|Uint8Array>} inputs
 * @returns {Uint8Array}
 */
export function mergePdfs(inputs) {
  const bin = mergeToBinary(inputs);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Merge PDFs into one multi-page PDF and return base64 (for chrome.downloads).
 * Throws if any input can't be parsed — the caller should fall back to raster.
 * @param {Array<string|Uint8Array>} inputs
 * @returns {string} base64
 */
export function mergePdfsToBase64(inputs) {
  return binaryToBase64(mergeToBinary(inputs));
}
