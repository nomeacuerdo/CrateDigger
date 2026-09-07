"use strict";

// Selector helper: returns the first element matching the selector, optionally scoped to a parent.
const $ = (s, p) => (p ?? document).querySelector(s);

// HTML escaping helper: makes untrusted strings safe to interpolate into innerHTML.
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Converts an api.discogs.com URL into the corresponding www.discogs.com browse page.
const browseUrl = (apiUrl) =>
  apiUrl
    ? apiUrl
        .replace("api.discogs.com/", "www.discogs.com/")
        .replace("/releases/", "/release/")
        .replace("/masters/", "/master/")
    : null;

// Display state: raw joined rows, active sort, active filter chip, and active shared-master group.
let rows = [];
let sort = { key: null, dir: 1 };
let filter = "all";
let group = null;

// Returns the master key used to join a collection item to the masters/releases maps, or null when the item has no master.
function masterKey(it) {
  const bio = it.basic_information ?? {};
  if (bio.master_url) return bio.master_url;
  if (bio.master_id) return "m" + bio.master_id;
  return null;
}

// Loads the three data files, joins them into display rows, and renders the page.
async function load() {
  const [coll, masters, releases] = await Promise.all([
    fetch("data/collection.json").then((r) => (r.ok ? r.json() : Promise.reject("data/collection.json " + r.status))),
    fetch("data/masters.json").then((r) => (r.ok ? r.json() : Promise.reject("data/masters.json " + r.status))),
    fetch("data/releases.json").then((r) => (r.ok ? r.json() : Promise.reject("data/releases.json " + r.status))),
  ]);

  const items = Array.isArray(coll) ? coll : coll.items ?? [];

  // Count how many collection items reference each master, to detect shared masters.
  const mcount = new Map();
  for (const it of items) {
    const k = masterKey(it);
    if (k) mcount.set(k, (mcount.get(k) ?? 0) + 1);
  }

  // Build one display row per collection item, resolving artist/title/released through masters and releases.
  rows = items.map((it, idx) => {
    const bio = it.basic_information ?? {};
    const mkey = masterKey(it);
    const main = mkey ? masters[mkey] ?? null : null;
    const info = main ? releases[main] ?? null : null;
    return {
      idx,
      it,
      bio,
      mkey,
      main,
      artist: info?.artists_sort || bio.artists?.map((a) => a.name).join(", ") || "Unknown",
      title: info?.title || bio.title || "Untitled",
      released: info?.released || (bio.year ? String(bio.year) : null),
      hasMaster: !!mkey,
      shared: mkey ? mcount.get(mkey) ?? 1 : 1,
    };
  });

  renderFilters();
  render();
}

// Applies the active filter chip and shared-master group, returning the rows that should be displayed.
function visibleRows() {
  if (group) return rows.filter((r) => r.mkey === group);
  if (filter === "shared") return rows.filter((r) => r.hasMaster && r.shared > 1);
  if (filter === "nomaster") return rows.filter((r) => !r.hasMaster);
  return rows;
}

// Returns a sorted copy of the given rows by the active column, or in original collection order when no column is selected.
function sortRows(list) {
  if (!sort.key) return [...list];
  return [...list].sort((a, b) => {
    if (a[sort.key] == null && b[sort.key] == null) return 0;
    if (a[sort.key] == null) return 1;
    if (b[sort.key] == null) return -1;
    return String(a[sort.key]).localeCompare(String(b[sort.key])) * sort.dir;
  });
}

// Rebuilds the header statistics and the filter chip bar (All / Shared masters / No master, plus the active group chip).
function renderFilters() {
  const withMaster = rows.filter((r) => r.hasMaster).length;
  const noMaster = rows.length - withMaster;
  const sharedRows = rows.filter((r) => r.hasMaster && r.shared > 1).length;
  const sharedGroups = new Set(rows.filter((r) => r.hasMaster && r.shared > 1).map((r) => r.mkey)).size;
  const distinct = new Set(rows.map((r) => r.main).filter(Boolean)).size;

  $("#stats").innerHTML =
    `${rows.length} items · ${withMaster} with a master · ${noMaster} without master · ` +
    `${distinct} distinct releases · ${sharedGroups} shared groups`;

  const chips = [
    { id: "all", label: `All (${rows.length})` },
    { id: "shared", label: `Shared masters (${sharedRows})` },
    { id: "nomaster", label: `No master (${noMaster})` },
  ];
  $("#filters").innerHTML = chips
    .map((c) => `<button class="chip ${filter === c.id ? "active" : ""}" data-filter="${c.id}">${esc(c.label)}</button>`)
    .join("");

  if (group) {
    const g = rows.find((r) => r.mkey === group);
    const n = rows.filter((r) => r.mkey === group).length;
    $("#filters").insertAdjacentHTML(
      "beforeend",
      `<button class="chip group" data-group-clear>Group: ${esc(g ? g.title : "?")} (${n}) &times;</button>`
    );
  }
}

// Rebuilds the table body from the visible + ordered rows, and updates the count and sort arrows.
function render() {
  const sorted = sortRows(visibleRows());
  $("#tbody").innerHTML = sorted
    .map((r) => {
      const cls = !r.hasMaster ? "row-nomaster" : r.shared > 1 ? "row-shared" : "";
      const badge = !r.hasMaster
        ? `<span class="badge nomaster">no master</span>`
        : r.shared > 1
          ? `<button class="badge shared" data-group="${esc(r.mkey)}">shared master &times;${r.shared}</button>`
          : `<span class="muted">master</span>`;
      return `<tr class="${cls}" data-idx="${r.idx}">
        <td class="muted">${r.idx + 1}</td>
        <td>${esc(r.artist)}</td>
        <td>${esc(r.title)}</td>
        <td>${esc(r.released ?? "-")}</td>
        <td>${badge}</td>
      </tr>`;
    })
    .join("");
  $("#count").textContent = `Showing ${sorted.length} of ${rows.length}`;

  document.querySelectorAll("th[data-key]").forEach((th) => {
    const arrow = th.querySelector(".arrow");
    arrow.textContent = th.dataset.key === sort.key ? (sort.dir === 1 ? "\u25B2" : "\u25BC") : "";
  });
}

// Fills the detail modal with the associated collection item's info and shows it.
function openModal(r) {
  const bio = r.bio;
  const formats = (bio.formats ?? [])
    .map((f) => {
      const d = [...(f.descriptions ?? []), f.text].filter(Boolean).join(", ");
      return `${esc(f.name)}${f.qty ? ` (${esc(f.qty)})` : ""}${d ? ` &mdash; ${esc(d)}` : ""}`;
    })
    .join("<br>");
  const labels = (bio.labels ?? [])
    .map((l) => `${esc(l.name)}${l.catno ? ` &mdash; ${esc(l.catno)}` : ""}`)
    .join("<br>");
  const notes = (r.it.notes ?? []).map((n) => esc(n.value)).join("<br>");
  const rating = r.it.rating > 0 ? `\u2605 ${r.it.rating}/5` : null;
  const cover = bio.cover_image ?? "";
  const releaseBrowse = browseUrl(bio.resource_url);
  const masterBrowse = browseUrl(r.mkey);
  const masterId = bio.master_id || null;
  const siblings = r.hasMaster && r.shared > 1 ? rows.filter((x) => x.mkey === r.mkey && x.idx !== r.idx) : [];

  const grid = [
    ["Artist", null, esc(r.artist)],
    ["Released", null, esc(r.released ?? "-")],
    ["Year", null, bio.year ? esc(bio.year) : null],
    ["Date added", null, r.it.date_added ? esc(r.it.date_added) : null],
    ["Rating", null, rating],
    ["Formats", null, formats || null],
    ["Labels", null, labels || null],
    ["Genres", null, bio.genres?.length ? esc(bio.genres.join(", ")) : null],
    ["Styles", null, bio.styles?.length ? esc(bio.styles.join(", ")) : null],
    ["Instance", null, r.it.instance_id ? String(r.it.instance_id) : null],
    ["Release ID", null, r.it.id ? String(r.it.id) : null],
    ["Master", null, masterId ? String(masterId) : null],
  ];

  $("#modal").innerHTML = `
    <button class="close" id="modalClose">&times;</button>
    ${cover ? `<img class="cover" src="${esc(cover)}" alt="">` : ""}
    <h2>${esc(r.title)}</h2>
    <div class="sub">${esc(r.artist)}</div>
    <dl class="modal-grid">${grid.map(([k, , v]) => (v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : "")).join("")}</dl>
    ${notes ? `<div class="siblings"><h3>Notes</h3><div>${notes}</div></div>` : ""}
    ${siblings.length ? `<div class="siblings"><h3>Also in collection (shared master)</h3><ul>${siblings.map((s) => `<li>${esc(s.artist)} &mdash; ${esc(s.title)}</li>`).join("")}</ul></div>` : ""}
    ${releaseBrowse || masterBrowse ? `<div class="dl">${releaseBrowse ? `<a href="${esc(releaseBrowse)}" target="_blank" rel="noopener">View on Discogs</a>` : ""}${masterBrowse ? `<a href="${esc(masterBrowse)}" target="_blank" rel="noopener">Master page</a>` : ""}</div>` : ""}`;

  $("#modalClose").addEventListener("click", closeModal);
  $("#modalBg").classList.add("open");
}

// Hides the detail modal.
function closeModal() {
  $("#modalBg").classList.remove("open");
}

// Applies the saved theme preference (dark by default) and syncs the toggle button label.
function applyTheme() {
  const light = localStorage.getItem("discos-theme") === "light";
  document.documentElement.classList.toggle("light", light);
  $("#themeToggle").textContent = light ? "Switch to dark" : "Switch to light";
}

// Resets sorting to the default collection order when the # column header is clicked.
function resetSort() {
  sort = { key: null, dir: 1 };
  render();
}

// Row click handling: shared-master badges filter to that group; any other click opens the details modal.
$("#tbody").addEventListener("click", (ev) => {
  const groupBtn = ev.target.closest("[data-group]");
  if (groupBtn) {
    group = groupBtn.dataset.group;
    renderFilters();
    render();
    return;
  }
  const tr = ev.target.closest("tr");
  if (tr) {
    const row = rows.find((r) => r.idx === Number(tr.dataset.idx));
    if (row) openModal(row);
  }
});

// Filter chip handling: All / Shared / No master select a filter; the group chip clears the shared-master group.
$("#filters").addEventListener("click", (ev) => {
  const chip = ev.target.closest("[data-filter]");
  if (chip) {
    filter = chip.dataset.filter;
    group = null;
    renderFilters();
    render();
    return;
  }
  if (ev.target.closest("[data-group-clear]")) {
    group = null;
    renderFilters();
    render();
  }
});

// Sortable column headers: clicking toggles ascending/descending for the selected column.
document.querySelectorAll("th[data-key]").forEach((th) => {
  th.addEventListener("click", () => {
    if (sort.key === th.dataset.key) sort.dir *= -1;
    else {
      sort.key = th.dataset.key;
      sort.dir = 1;
    }
    render();
  });
});

// Clicking the # header returns to the default collection order.
$("#thReset").addEventListener("click", resetSort);

// Theme toggle: switches between light and dark (default) and remembers the choice for next visits.
$("#themeToggle").addEventListener("click", () => {
  const light = document.documentElement.classList.toggle("light");
  localStorage.setItem("discos-theme", light ? "light" : "dark");
  $("#themeToggle").textContent = light ? "Switch to dark" : "Switch to light";
});

// Clicking the dark backdrop closes the modal.
$("#modalBg").addEventListener("click", (ev) => {
  if (ev.target.id === "modalBg") closeModal();
});

// Pressing Escape closes the modal.
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeModal();
});

applyTheme();
load();