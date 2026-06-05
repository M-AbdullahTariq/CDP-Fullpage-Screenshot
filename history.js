import { listHistory, clearHistory } from "./src/history.js";

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const clearBtn = document.getElementById("clear");

/** Basename of a download's on-disk path (Chrome stores the full path). */
function basename(path) {
  return (path || "").split(/[\\/]/).pop();
}

/**
 * Map each saved filename to its most-recent matching chrome.downloads id, so a
 * row's Open/Show can fire synchronously inside the click gesture (open()
 * requires a user gesture and loses it across an await). Returns Map<name, id>.
 */
async function buildDownloadIndex() {
  const map = new Map();
  try {
    const all = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 0 });
    for (const d of all) {
      const name = basename(d.filename);
      if (name && !map.has(name)) map.set(name, d.id); // first seen = most recent
    }
  } catch {
    /* downloads unreadable — every row falls back to "file not found" */
  }
  return map;
}

function makeButton(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function renderRow(entry, downloadId) {
  const li = document.createElement("li");

  const meta = document.createElement("div");
  meta.className = "meta";

  const title = document.createElement("div");
  title.className = "title";
  const label = entry.title || entry.host || entry.url || "(untitled capture)";
  if (entry.url) {
    const a = document.createElement("a");
    a.href = entry.url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = label;
    title.appendChild(a);
  } else {
    title.textContent = label;
  }

  const sub = document.createElement("div");
  sub.className = "sub";
  const bits = [entry.host, entry.date].filter(Boolean).join(" · ");
  sub.append(document.createTextNode(bits ? bits + " · " : ""));
  const file = document.createElement("span");
  file.className = "file";
  file.textContent = entry.filename;
  sub.appendChild(file);

  meta.append(title, sub);

  const actions = document.createElement("div");
  actions.className = "actions";

  if (downloadId != null) {
    actions.append(
      makeButton("Open", "secondary", () => chrome.downloads.open(downloadId)),
      makeButton("Show", "secondary", () => chrome.downloads.show(downloadId)),
    );
  } else {
    const missing = document.createElement("span");
    missing.className = "missing";
    missing.textContent = "file not found";
    actions.appendChild(missing);
  }

  li.append(meta, actions);
  return li;
}

async function render() {
  const [entries, index] = await Promise.all([listHistory(), buildDownloadIndex()]);

  listEl.replaceChildren();
  emptyEl.hidden = entries.length > 0;
  clearBtn.disabled = entries.length === 0;

  for (const entry of entries) {
    listEl.appendChild(renderRow(entry, index.get(entry.filename)));
  }
}

clearBtn.addEventListener("click", async () => {
  await clearHistory();
  await render();
});

render();
