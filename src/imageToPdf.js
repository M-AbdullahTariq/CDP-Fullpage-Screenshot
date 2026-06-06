// ImageToPdf — wrap a raster screenshot (JPEG or PNG) into a PDF, optionally with
// an invisible selectable-text layer and clickable link annotations.
//
// This is the Robust-capture fallback's output builder: when printToPDF can't render
// a page (virtualized feeds, heavy fixed/sticky), we screenshot the pixels and embed
// them here. The image carries the look; an invisible text layer (text render mode
// `3 Tr`) makes it selectable/searchable; /URI link annotations keep links clickable.
//
// Pure: bytes in, PDF bytes out — no Chrome, no DOM. Two image paths, neither decodes
// or recompresses pixels in the worker:
//   • JPEG → embedded directly as a /DCTDecode image XObject (raw file bytes).
//   • PNG  → embedded as a /FlateDecode image reusing the IDAT stream with a PNG
//            predictor (/Predictor 15) in DecodeParms. Only non-interlaced grayscale
//            (color type 0) and truecolor RGB (color type 2) are embeddable without
//            decoding; alpha/palette/interlaced PNGs throw (capture as JPEG instead).
//
// Coordinate contract: textRuns/links boxes are in CSS px relative to the captured
// region's top-left (the natural getBoundingClientRect space), y-down. The image's
// pixel dimensions divided by `scale` give the CSS size, so a 2x screenshot still
// prints at 1x physical size and the boxes line up without rescaling.

import { PX_PER_INCH } from "./dimensionCalculator.js";

// PDF user-space units are points (72 per inch); CSS px are PX_PER_INCH per inch.
const PT_PER_PX = 72 / PX_PER_INCH;

/** Format a number for PDF output: max 3 decimals, no trailing zeros, no -0. */
function fmt(n) {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1000) / 1000;
  return (r === 0 ? 0 : r).toString();
}

/** Big-endian uint32 at offset. */
function readU32(b, o) {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** Concatenate a list of Uint8Arrays into one. */
function concatBytes(chunks) {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Coerce a Uint8Array or base64 string to bytes. */
function toBytes(image) {
  if (image instanceof Uint8Array) return image;
  if (typeof image === "string") {
    const bin = typeof atob !== "undefined" ? atob(image) : Buffer.from(image, "base64").toString("binary");
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i) & 0xff;
    return u;
  }
  throw new Error("imageToPdf: image must be a Uint8Array or base64 string.");
}

/**
 * Parse a JPEG's frame header for pixel dimensions and component count. The whole
 * file is embedded as-is via DCTDecode.
 */
function parseJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("imageToPdf: not a JPEG.");
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    let marker = bytes[i + 1];
    while (marker === 0xff) {
      i++;
      marker = bytes[i + 1];
    }
    i += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const len = (bytes[i] << 8) | bytes[i + 1];
    // SOF0..SOF15 carry the frame dims, except DHT(C4)/JPG(C8)/DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const pixelH = (bytes[i + 3] << 8) | bytes[i + 4];
      const pixelW = (bytes[i + 5] << 8) | bytes[i + 6];
      const components = bytes[i + 7];
      const colorSpace = components === 1 ? "/DeviceGray" : components === 4 ? "/DeviceCMYK" : "/DeviceRGB";
      return {
        pixelW,
        pixelH,
        stream: bytes,
        parms: `/ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /DCTDecode`,
      };
    }
    i += len;
  }
  throw new Error("imageToPdf: could not find a JPEG frame header.");
}

/**
 * Parse a PNG: read IHDR, collect IDAT. Returns the raw (still zlib-compressed) IDAT
 * stream for direct embedding with a PNG predictor — no pixel decode. Rejects formats
 * that can't be embedded this way.
 */
function parsePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== sig[i]) throw new Error("imageToPdf: not a PNG.");
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= bytes.length) {
    const len = readU32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const dataStart = off + 8;
    if (type === "IHDR") {
      ihdr = {
        w: readU32(bytes, dataStart),
        h: readU32(bytes, dataStart + 4),
        bitDepth: bytes[dataStart + 8],
        colorType: bytes[dataStart + 9],
        interlace: bytes[dataStart + 12],
      };
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    off = dataStart + len + 4; // skip data + 4-byte CRC
  }
  if (!ihdr) throw new Error("imageToPdf: PNG missing IHDR.");
  if (ihdr.interlace !== 0) {
    throw new Error("imageToPdf: interlaced PNG unsupported — capture as JPEG instead.");
  }
  if (ihdr.colorType !== 0 && ihdr.colorType !== 2) {
    throw new Error(
      `imageToPdf: PNG color type ${ihdr.colorType} (alpha/palette) can't be embedded without decoding — capture as JPEG instead.`,
    );
  }
  const colors = ihdr.colorType === 2 ? 3 : 1;
  const colorSpace = ihdr.colorType === 2 ? "/DeviceRGB" : "/DeviceGray";
  return {
    pixelW: ihdr.w,
    pixelH: ihdr.h,
    stream: concatBytes(idat),
    parms:
      `/ColorSpace ${colorSpace} /BitsPerComponent ${ihdr.bitDepth} /Filter /FlateDecode ` +
      `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${ihdr.bitDepth} /Columns ${ihdr.w} >>`,
  };
}

/** Escape a string for a PDF literal `(...)`, dropping chars outside Latin-1. */
function pdfString(text) {
  let out = "";
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    if (c > 255) {
      out += "?"; // best-effort: WinAnsi base font can't represent it
    } else if (ch === "\\") {
      out += "\\\\";
    } else if (ch === "(") {
      out += "\\(";
    } else if (ch === ")") {
      out += "\\)";
    } else if (c === 13) {
      out += "\\r";
    } else if (c === 10) {
      out += "\\n";
    } else if (c === 9) {
      out += "\\t";
    } else if (c < 32) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

/** Build the page content stream: draw the image, then overlay invisible text runs. */
function pageContent(wpt, hpt, textRuns) {
  let s = `q\n${fmt(wpt)} 0 0 ${fmt(hpt)} 0 0 cm\n/Im0 Do\nQ\n`;
  for (const run of textRuns) {
    const box = run.box;
    if (!box || !(box.width > 0)) continue;
    const fs = (run.fontSize ?? box.height) * PT_PER_PX;
    if (!(fs > 0)) continue;
    const x = box.left * PT_PER_PX;
    // PDF origin is bottom-left; place the baseline near the box's bottom edge.
    const y = hpt - (box.top + box.height) * PT_PER_PX;
    s += `BT\n/F0 ${fmt(fs)} Tf\n3 Tr\n${fmt(x)} ${fmt(y)} Td\n(${pdfString(run.text)}) Tj\nET\n`;
  }
  return s;
}

/** Build a /URI link annotation dict for a link box (CSS px) on a page of height hpt. */
function linkAnnot(parentRef, link, hpt) {
  const b = link.box;
  const x0 = b.left * PT_PER_PX;
  const x1 = (b.left + b.width) * PT_PER_PX;
  const y1 = hpt - b.top * PT_PER_PX;
  const y0 = hpt - (b.top + b.height) * PT_PER_PX;
  return (
    `<< /Type /Annot /Subtype /Link /Border [0 0 0] ` +
    `/Rect [${fmt(x0)} ${fmt(y0)} ${fmt(x1)} ${fmt(y1)}] ` +
    `/A << /Type /Action /S /URI /URI (${pdfString(link.url)}) >> >>`
  );
}

/** Normalize one page input into the pieces the assembler needs. */
function preparePage(page) {
  const { image, format, scale = 1, textRuns = [], links = [] } = page ?? {};
  if (!(scale > 0)) throw new Error("imageToPdf: scale must be a positive number.");
  const bytes = toBytes(image);
  let img;
  if (format === "jpeg" || format === "jpg") img = parseJpeg(bytes);
  else if (format === "png") img = parsePng(bytes);
  else throw new Error("imageToPdf: format must be 'jpeg' or 'png'.");
  if (!(img.pixelW > 0 && img.pixelH > 0)) {
    throw new Error("imageToPdf: image has no pixel dimensions.");
  }
  const cssW = img.pixelW / scale;
  const cssH = img.pixelH / scale;
  const wpt = cssW * PT_PER_PX;
  const hpt = cssH * PT_PER_PX;
  return {
    img,
    wpt,
    hpt,
    content: pageContent(wpt, hpt, textRuns),
    hasText: textRuns.some((r) => r?.box?.width > 0),
    links,
  };
}

// --- low-level PDF writer ----------------------------------------------------

/** Collects mixed string/byte parts and serializes to a single Uint8Array. */
function makeWriter() {
  const parts = [];
  let len = 0;
  return {
    get len() {
      return len;
    },
    str(s) {
      parts.push(s);
      len += s.length; // ASCII/Latin-1: 1 char === 1 byte
    },
    bytes(u8) {
      parts.push(u8);
      len += u8.length;
    },
    toUint8() {
      const out = new Uint8Array(len);
      let o = 0;
      for (const p of parts) {
        if (typeof p === "string") {
          for (let i = 0; i < p.length; i++) out[o++] = p.charCodeAt(i) & 0xff;
        } else {
          out.set(p, o);
          o += p.length;
        }
      }
      return out;
    },
  };
}

/**
 * Assemble a PDF from one or more prepared pages. One shared font object (only if any
 * page has text); per page: a Page, an Image XObject, a Contents stream, and one
 * annotation per link. Object ids are contiguous from 1; the xref records byte offsets.
 */
function assemble(prepared) {
  let nextId = 1;
  const alloc = () => nextId++;

  const catalogId = alloc();
  const pagesId = alloc();
  const anyText = prepared.some((p) => p.hasText);
  const fontId = anyText ? alloc() : null;

  const pages = prepared.map((p) => ({
    p,
    pageId: alloc(),
    imageId: alloc(),
    contentId: alloc(),
    linkIds: p.links.map(() => alloc()),
  }));

  // Each object: { id, parts: [...strings/bytes...] } including the `N 0 obj` wrapper.
  const objects = [];
  const put = (id, bodyParts) => {
    const body = Array.isArray(bodyParts) ? bodyParts : [bodyParts];
    objects.push({ id, parts: [`${id} 0 obj\n`, ...body, `\nendobj\n`] });
  };

  put(catalogId, `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  put(
    pagesId,
    `<< /Type /Pages /Kids [${pages.map((o) => `${o.pageId} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  );
  if (fontId) {
    put(fontId, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
  }

  for (const o of pages) {
    const fontRes = fontId ? ` /Font << /F0 ${fontId} 0 R >>` : "";
    const procSet = fontId ? "/ProcSet [/PDF /Text /ImageC]" : "/ProcSet [/PDF /ImageC]";
    const annots = o.linkIds.length ? ` /Annots [${o.linkIds.map((id) => `${id} 0 R`).join(" ")}]` : "";
    put(
      o.pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${fmt(o.p.wpt)} ${fmt(o.p.hpt)}] ` +
        `/Resources << /XObject << /Im0 ${o.imageId} 0 R >>${fontRes} ${procSet} >> ` +
        `/Contents ${o.contentId} 0 R${annots} >>`,
    );

    const img = o.p.img;
    put(o.imageId, [
      `<< /Type /XObject /Subtype /Image /Width ${img.pixelW} /Height ${img.pixelH} ${img.parms} /Length ${img.stream.length} >>\nstream\n`,
      img.stream,
      `\nendstream`,
    ]);

    put(o.contentId, `<< /Length ${o.p.content.length} >>\nstream\n${o.p.content}\nendstream`);

    o.linkIds.forEach((id, i) => put(id, linkAnnot(o.pageId, o.p.links[i], o.p.hpt)));
  }

  objects.sort((a, b) => a.id - b.id);

  const w = makeWriter();
  w.str("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"); // binary marker so tools treat the file as binary
  const offsets = new Array(nextId).fill(0);
  for (const obj of objects) {
    offsets[obj.id] = w.len;
    for (const part of obj.parts) (typeof part === "string" ? w.str(part) : w.bytes(part));
  }

  const xrefOffset = w.len;
  w.str(`xref\n0 ${nextId}\n`);
  w.str("0000000000 65535 f \n");
  for (let id = 1; id < nextId; id++) {
    w.str(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  }
  w.str(`trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

  return w.toUint8();
}

/**
 * Build a single-page PDF from one raster image (+ optional invisible text + links).
 * @param {object} page
 * @param {Uint8Array|string} page.image  raw image bytes or base64
 * @param {"jpeg"|"png"} page.format
 * @param {number} [page.scale=1]  device-scale the image was captured at
 * @param {Array<{text:string,box:{top:number,left:number,width:number,height:number},fontSize?:number}>} [page.textRuns]
 * @param {Array<{url:string,box:{top:number,left:number,width:number,height:number}}>} [page.links]
 * @returns {Uint8Array} PDF bytes
 */
export function buildImagePdf(page) {
  return assemble([preparePage(page)]);
}

/**
 * Build a multi-page PDF — one raster image per page. Used by the Multi-select
 * "one multi-page PDF" output.
 * @param {Array} pages  same shape as buildImagePdf's argument
 * @returns {Uint8Array} PDF bytes
 */
export function buildMultiImagePdf(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error("imageToPdf: buildMultiImagePdf needs at least one page.");
  }
  return assemble(pages.map(preparePage));
}

/** Base64-encode PDF bytes for chrome.downloads (which takes a data: URL payload). */
export function pdfBytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}
