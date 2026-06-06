// Settings page — explicit Save/Cancel model.
//
// On load, the form is populated from the persisted settings. Edits live in the
// form only; nothing is written until the user clicks Save. Save persists the
// whole form via the settings module (which clamps/coerces/validates), reflects
// the corrected values back into the form, and shows a transient "Saved"
// confirmation. Cancel — and simply closing the tab — discards unsaved edits.

import { loadSettings, saveSettings } from "./src/settings.js";
import { PRESETS } from "./src/filenameTemplate.js";

const els = {
  preCaptureDelayMs: document.getElementById("preCaptureDelayMs"),
  scrollSpeedMs: document.getElementById("scrollSpeedMs"),
  maxScrollSteps: document.getElementById("maxScrollSteps"),
  maxScrollSeconds: document.getElementById("maxScrollSeconds"),
  allTabsVisibleOnly: document.getElementById("allTabsVisibleOnly"),
  filenameTemplate: document.getElementById("filenameTemplate"),
  indexPadZeros: document.getElementById("indexPadZeros"),
  filenameMaxLen: document.getElementById("filenameMaxLen"),
  showInFolderAfterSave: document.getElementById("showInFolderAfterSave"),
  outputSubfolder: document.getElementById("outputSubfolder"),
  historyRetentionDays: document.getElementById("historyRetentionDays"),
  closeTabAfter: document.getElementById("closeTabAfter"),
  frameAudit: document.getElementById("frameAudit"),
  captureStrategy: document.getElementById("captureStrategy"),
  multiSelectOutput: document.getElementById("multiSelectOutput"),
  rasterFormat: document.getElementById("rasterFormat"),
  rasterJpegQuality: document.getElementById("rasterJpegQuality"),
  rasterScale: document.getElementById("rasterScale"),
};
const presetsEl = document.getElementById("presets");
const saveBtn = document.getElementById("save");
const cancelBtn = document.getElementById("cancel");
const status = document.getElementById("status");

let savedTimer = null;

/** Write a settings object into the form controls. */
function fillForm(s) {
  els.preCaptureDelayMs.value = s.preCaptureDelayMs;
  els.scrollSpeedMs.value = s.scrollSpeedMs;
  els.maxScrollSteps.value = s.maxScrollSteps;
  els.maxScrollSeconds.value = s.maxScrollSeconds;
  els.allTabsVisibleOnly.checked = s.allTabsVisibleOnly;
  els.filenameTemplate.value = s.filenameTemplate;
  els.indexPadZeros.value = s.indexPadZeros;
  els.filenameMaxLen.value = s.filenameMaxLen;
  els.showInFolderAfterSave.checked = s.showInFolderAfterSave;
  els.outputSubfolder.value = s.outputSubfolder;
  els.historyRetentionDays.value = String(s.historyRetentionDays);
  els.closeTabAfter.checked = s.closeTabAfter;
  els.frameAudit.checked = s.frameAudit;
  els.captureStrategy.value = s.captureStrategy;
  els.multiSelectOutput.value = s.multiSelectOutput;
  els.rasterFormat.value = s.rasterFormat;
  els.rasterJpegQuality.value = s.rasterJpegQuality;
  els.rasterScale.value = s.rasterScale;
  syncRasterQualityEnabled();
}

/** JPEG quality only applies to JPEG output — disable it for PNG. */
function syncRasterQualityEnabled() {
  els.rasterJpegQuality.disabled = els.rasterFormat.value !== "jpeg";
}

/** Read the current form values into a plain settings patch. */
function readForm() {
  const hr = els.historyRetentionDays.value;
  return {
    preCaptureDelayMs: Number(els.preCaptureDelayMs.value),
    scrollSpeedMs: Number(els.scrollSpeedMs.value),
    maxScrollSteps: Number(els.maxScrollSteps.value),
    maxScrollSeconds: Number(els.maxScrollSeconds.value),
    allTabsVisibleOnly: els.allTabsVisibleOnly.checked,
    filenameTemplate: els.filenameTemplate.value,
    indexPadZeros: Number(els.indexPadZeros.value),
    filenameMaxLen: Number(els.filenameMaxLen.value),
    showInFolderAfterSave: els.showInFolderAfterSave.checked,
    outputSubfolder: els.outputSubfolder.value,
    historyRetentionDays: hr === "all" ? "all" : Number(hr),
    closeTabAfter: els.closeTabAfter.checked,
    frameAudit: els.frameAudit.checked,
    captureStrategy: els.captureStrategy.value,
    multiSelectOutput: els.multiSelectOutput.value,
    rasterFormat: els.rasterFormat.value,
    rasterJpegQuality: Number(els.rasterJpegQuality.value),
    rasterScale: Number(els.rasterScale.value),
  };
}

function setStatus(text, cls = "") {
  status.className = cls;
  status.textContent = text;
}

// --- Preset buttons (fill the template field; not persisted until Save) ------

for (const preset of PRESETS) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = preset.label;
  b.title = preset.template;
  b.addEventListener("click", () => {
    els.filenameTemplate.value = preset.template;
    els.filenameTemplate.focus();
  });
  presetsEl.appendChild(b);
}

// Keep the JPEG-quality field enabled state in sync as the user switches format.
els.rasterFormat.addEventListener("change", syncRasterQualityEnabled);

// --- Load current values (no persistence) -----------------------------------

(async () => {
  fillForm(await loadSettings());
})();

// --- Save --------------------------------------------------------------------

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  try {
    // saveSettings merges + clamps + validates; reflect the corrected values
    // back (e.g. a sanitized subfolder, a clamped number) so the user sees
    // exactly what was persisted.
    const merged = await saveSettings(readForm());
    fillForm(merged);
    setStatus("Saved ✓", "ok");
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => setStatus(""), 2500);
  } catch (err) {
    setStatus(err?.message || "Could not save.", "err");
  } finally {
    saveBtn.disabled = false;
  }
});

// --- Cancel (discard) --------------------------------------------------------

cancelBtn.addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id) chrome.tabs.remove(tab.id);
  else window.close();
});
