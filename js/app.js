// Copyright (C) 2026 Aron Sommer. See LICENSE file for full license details.

import {
  Mtp,
  OP,
  STALLED,
  USB_FILTERS,
  ROOT_PARENT,
  offersMtp,
} from "./mtp.js?v=__BUILD_TIMESTAMP__";

// Comments cite these sources by tag; "Observed" marks behaviour seen while
// testing with real phones, not read from a source.
//
//   [FSA]        https://wicg.github.io/file-system-access/
//   [crswap]     https://chromium.googlesource.com/chromium/src/+/main/content/browser/file_system_access/file_system_access_file_handle_impl.cc
//   [Blocked]    https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc
//   [WebUSB]     https://usb.spec.whatwg.org/
//   [mtp.h]      https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/mtp.h
//   [MtpUtils]   https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/media/mtp/MtpUtils.cpp
//   [MtpStorageManager] https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/media/java/android/mtp/MtpStorageManager.java
//   [Storage]    https://source.android.com/docs/core/storage/traditional
//   [Blink]      https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/webusb/usb_device.cc

/* ------------------------------------------------------------------ */
/* icons                                                               */
/* ------------------------------------------------------------------ */

// Material Symbols, self-hosted as a subset font. Glyph names, not paths;
// see fonts/README.md to add one.
const ICON = {
  folder: "folder",
  image: "image",
  video: "movie",
  audio: "audiotrack",
  doc: "description",
  mac: "computer",
  phone: "android",
  check: "check",
  close: "close",
  waiting: "schedule",
  busy: "autorenew",
  refresh: "refresh",
  newFolder: "create_new_folder",
  rename: "edit",
  trash: "delete",
  sortUp: "keyboard_arrow_up",
  sortDown: "keyboard_arrow_down",
  arrow: "arrow_forward",
  back: "arrow_back",
  warn: "error",
};

const icon = (name, cls = "") =>
  `<span class="material-symbols${cls ? " " + cls : ""}">${name}</span>`;

const kindOf = (n) => {
  const e = n.split(".").pop().toLowerCase();
  if (/^(jpg|jpeg|png|heic|heif|webp|gif|dng|bmp|tif|tiff)$/.test(e)) return "image";
  if (/^(mp4|mov|mkv|webm|avi|3gp|m4v)$/.test(e)) return "video";
  if (/^(mp3|m4a|flac|wav|ogg|opus|aac)$/.test(e)) return "audio";
  return "doc";
};

const fmtSize = (b) =>
  b == null
    ? "—"
    : b >= 1e9
      ? (b / 1e9).toFixed(2) + " GB"
      : b >= 1e6
        ? (b / 1e6).toFixed(1) + " MB"
        : b >= 1e3
          ? Math.round(b / 1e3) + " KB"
          : b + " B";

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n) => String(n).padStart(2, "0");

// Fixed width so the column lines up.
const fmtDate = (d) =>
  d
    ? `${pad2(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    : "—";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

let mtp = null;
let storage = null; // from mtp.getStorageInfo()

const S = {
  mac: {
    label: "This Mac",
    icon: ICON.mac,
    root: null,
    stack: [],
    anchor: null,
    entries: [],
    sel: new Set(),
    sort: { key: "name", dir: 1 },
    busy: false,
    gen: 0,
    el: $("pane-mac"),
  },
  phone: {
    label: "Phone",
    icon: ICON.phone,
    stack: [],
    anchor: null,
    entries: [],
    sel: new Set(),
    sort: { key: "name", dir: 1 },
    busy: false,
    gen: 0,
    el: $("pane-phone"),
  },
};

const macDir = () => (S.mac.stack.length ? S.mac.stack.at(-1).handle : S.mac.root);
const phoneParent = () => (S.phone.stack.length ? S.phone.stack.at(-1).handle : ROOT_PARENT);

/* ------------------------------------------------------------------ */
/* remembering the Mac folder between visits                           */
/* ------------------------------------------------------------------ */

function idbStore(mode) {
  return new Promise((res, rej) => {
    const req = indexedDB.open("droidfiletransfer", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("handles");
    req.onerror = () => rej(req.error);
    req.onsuccess = () => res(req.result.transaction("handles", mode).objectStore("handles"));
  });
}
async function saveDir(handle) {
  try {
    (await idbStore("readwrite")).put(handle, "macDir");
  } catch {}
}
async function loadDir() {
  try {
    const store = await idbStore("readonly");
    return await new Promise((res) => {
      const r = store.get("macDir");
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* listing                                                             */
/* ------------------------------------------------------------------ */

async function listMac() {
  const dir = macDir();
  if (!dir) return [];
  const out = [];
  for await (const [name, handle] of dir.entries()) {
    // .crswap is Chrome's swap file for a write still in progress [crswap].
    if (name.startsWith(".") || name.endsWith(".crswap")) continue;
    if (handle.kind === "directory") {
      out.push({ name, isDir: true, size: null, modified: null, handle });
    } else {
      try {
        const f = await handle.getFile();
        out.push({
          name,
          isDir: false,
          size: f.size,
          modified: new Date(f.lastModified),
          handle,
        });
      } catch {
        out.push({ name, isDir: false, size: 0, modified: null, handle });
      }
    }
  }
  return out;
}

async function listPhone() {
  if (!mtp || !storage) return [];
  return await mtp.list(storage.id, phoneParent());
}

// Re-reads the free space shown in the phone pane's footer.
async function refreshStorage() {
  if (!mtp || !storage) return;
  try {
    storage = await mtp.getStorageInfo(storage.id);
  } catch {}
}

// The breadcrumb stays clickable while a listing runs, so listings can
// overlap. Only the latest may fill the pane: a slow listing of one folder
// landing under another folder's breadcrumb would make Delete, which goes by
// name in the breadcrumb folder, remove the wrong file.
async function refresh(side, keepSelection = false) {
  const p = S[side];
  const gen = ++p.gen;
  p.busy = true;
  if (!keepSelection) p.sel.clear();
  render(side);
  let entries = [];
  try {
    entries = side === "mac" ? await listMac() : await listPhone();
  } catch (e) {
    if (gen === p.gen) fail(`Could not read ${side === "mac" ? "this folder" : "the phone"}`, e);
  }
  if (gen !== p.gen) return;
  setEntries(p, entries);
  p.busy = false;
  render(side);
}

// Drops selected names that are no longer listed.
function setEntries(p, entries) {
  p.entries = entries;
  for (const n of p.sel) if (!entries.some((e) => e.name === n)) p.sel.delete(n);
}

// Picks up changes made outside the app when the window regains focus.
// Renders only if the listing changed, so the keyboard focus survives.
async function recheck(side) {
  const p = S[side];
  // A phone listing would queue behind a running transfer, so skip it then.
  if (p.busy || (side === "mac" ? !p.root : !storage || running || expanding)) return;
  const at = p.stack.at(-1)?.handle ?? p.root;
  let entries;
  try {
    entries = side === "mac" ? await listMac() : await listPhone();
  } catch {
    return;
  }
  if (p.busy || (p.stack.at(-1)?.handle ?? p.root) !== at) return;
  const sig = (list) =>
    list
      .map((e) => `${e.name}/${e.size}/${e.modified?.getTime()}`)
      .sort()
      .join("\n");
  if (sig(entries) === sig(p.entries)) return;
  setEntries(p, entries);
  render(side);
}

window.addEventListener("focus", () => {
  recheck("mac");
  recheck("phone");
});

/* ------------------------------------------------------------------ */
/* render                                                              */
/* ------------------------------------------------------------------ */

const byName = (a, b) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

function sorted(p) {
  const items = [...p.entries];
  const { key, dir } = p.sort;
  items.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // folders always lead
    let r;
    if (key === "size") r = (a.size ?? -1) - (b.size ?? -1);
    else if (key === "date") r = (a.modified?.getTime() ?? 0) - (b.modified?.getTime() ?? 0);
    else r = byName(a, b);
    // Folders have no size or date, and files can share either, so the name
    // decides ties: otherwise they keep the order the Mac or the phone listed
    // them in, which can differ from one reading to the next. Ascending in both
    // directions, since these rows have nothing for the arrow to reverse.
    return r * dir || byName(a, b);
  });
  return items;
}

// The buttons that act on the listing. The label lives in the tooltip, and the
// footer already counts what is selected. New folder comes last: it is the one
// that needs no selection, so it sits in the same place on both panes.
const ACTS = [
  {
    act: "rename",
    glyph: ICON.rename,
    label: "Rename",
    phoneOnly: true,
    ok: (p) => p.sel.size === 1,
  },
  { act: "delete", glyph: ICON.trash, label: "Delete", ok: (p) => p.sel.size > 0 },
  { act: "mkdir", glyph: ICON.newFolder, label: "New folder", ok: () => true },
];

// Always all of them, so the header keeps its shape; syncTools() greys out the
// ones that cannot be used.
const acts = (side) =>
  ACTS.filter((a) => side === "phone" || !a.phoneOnly)
    .map(
      (a) =>
        `<button class="btn icon" data-act="${a.act}" title="${a.label}" aria-label="${a.label}">${icon(a.glyph)}</button>`,
    )
    .join("");

// What a pane header can do right now, in one place. Called from
// updateArrows(), which every change of running and expanding already passes
// through, so a copy greys these out as it starts rather than at the next
// render.
function syncTools(side) {
  const p = S[side];
  const copying = running || expanding;
  const off = (sel, state) => {
    const el = p.el.querySelector(sel);
    if (el) el.disabled = state;
  };
  // Rename and Delete also need a selection; New folder only needs the folder.
  for (const a of ACTS) off(`[data-act="${a.act}"]`, p.busy || copying || !a.ok(p));
  // The pane's own button: Change folder on the Mac, Disconnect on the phone.
  off('#change-dir, [data-act="disconnect"]', copying);
  // A phone listing would queue behind the transfer; a Mac one is local.
  off('[data-act="refresh"]', side === "phone" && copying);
}

// The phone cannot be browsed during a copy: the listing would queue behind the
// transfer and leave the pane on "Reading…" until it finished. The Mac is local.
const canBrowse = (side) => side === "mac" || !(running || expanding);

function render(side) {
  const p = S[side];
  const items = sorted(p);
  const caret = (k) =>
    p.sort.key === k ? icon(p.sort.dir > 0 ? ICON.sortUp : ICON.sortDown, "caret") : "";
  const on = (k) => (p.sort.key === k ? "on" : "");

  const noFolder = side === "mac" && !p.root;
  const rootName = side === "mac" ? p.root?.name : storage?.description || "Internal storage";
  const crumbs = noFolder
    ? []
    : [
        `<button class="crumb ${p.stack.length ? "" : "here"}" data-go="0">${esc(rootName)}</button>`,
      ];
  p.stack.forEach((seg, i) => {
    crumbs.push('<span class="sep">/</span>');
    crumbs.push(
      `<button class="crumb ${i === p.stack.length - 1 ? "here" : ""}" data-go="${i + 1}">${esc(seg.name)}</button>`,
    );
  });

  let body;
  if (p.busy) body = `<div class="empty busy"><p>Reading…</p></div>`;
  else if (noFolder)
    // Chrome blocks those folders themselves but allows folders inside them [Blocked].
    body = `<div class="empty"><div class="pick">
      ${icon(ICON.folder)}
      <p>Choose the folder on this Mac the app may use. Files are copied to and from it.</p>
      <button class="btn primary" id="change-dir">Choose folder</button>
      <p>Chrome refuses the Documents, Desktop, Downloads and home folders directly, so use or create a folder inside one, such as Documents/Phone.</p>
    </div></div>`;
  else if (!items.length) body = `<div class="empty"><p>This folder is empty</p></div>`;
  else
    body = items
      .map(
        (it) => `
    <div class="row ${it.isDir ? "dir" : ""} ${p.sel.has(it.name) ? "on" : ""}" data-n="${esc(it.name)}" tabindex="0">
      <div class="name">${it.isDir ? icon(ICON.folder) : icon(ICON[kindOf(it.name)])}<span>${esc(it.name)}</span></div>
      <div class="size">${it.isDir ? "—" : fmtSize(it.size)}</div>
      <div class="date">${fmtDate(it.modified)}</div>
    </div>`,
      )
      .join("");

  const tools = noFolder
    ? ""
    : `<span class="pane-tools">${acts(side)}</span>` +
      (side === "mac"
        ? `<button class="btn" id="change-dir">Change folder</button>`
        : `<button class="btn" data-act="disconnect">Disconnect</button>`);

  const nDirs = items.filter((i) => i.isDir).length;
  const nFiles = items.length - nDirs;
  // Folders have no size here, so a total is shown only for a set of files.
  const bytes = (list) =>
    list.some((i) => i.isDir) ? 0 : list.reduce((a, b) => a + (b.size || 0), 0);
  const selBytes = bytes(items.filter((i) => p.sel.has(i.name)));
  const totalBytes = bytes(items);
  const line = (parts) => parts.filter(Boolean).join(" · ");

  const counts = line([
    nDirs && `${nDirs} folder${nDirs > 1 ? "s" : ""}`,
    nFiles && `${nFiles} file${nFiles > 1 ? "s" : ""}`,
    totalBytes && fmtSize(totalBytes),
  ]);

  // Rebuilding the list resets its scroll, so carry it over.
  const scroll = p.el.querySelector(".list")?.scrollTop;
  p.el.innerHTML = `
    <div class="pane-top">
      <div class="pane-label">${icon(p.icon)}<span class="pane-name" ${p.tip ? `title="${esc(p.tip)}"` : ""}>${esc(p.label)}</span>
        <span class="spacer"></span>
        ${tools}
      </div>
      <div class="crumbs">
        ${noFolder ? "" : `<button class="btn reload ${p.busy ? "busy" : ""}" data-act="refresh" title="Refresh" aria-label="Refresh">${icon(p.busy ? ICON.busy : ICON.refresh)}</button>`}
        ${crumbs.join("")}
      </div>
    </div>
    <div class="cols">
      <button class="col ${on("name")}" data-sort="name">Name ${caret("name")}</button>
      <button class="col n ${on("size")}" data-sort="size">Size ${caret("size")}</button>
      <button class="col n ${on("date")}" data-sort="date">Modified ${caret("date")}</button>
    </div>
    <div class="list" tabindex="-1">${body}</div>
    <div class="pane-foot">
      ${p.sel.size ? line([`${p.sel.size} selected`, selBytes && fmtSize(selBytes)]) : counts}
      <span class="spacer"></span>
      ${
        side === "phone" && storage
          ? `<span class="meter"><span style="width:${Math.round(((storage.capacity - storage.free) / storage.capacity) * 100)}%"></span></span>${fmtSize(storage.free)} free of ${fmtSize(storage.capacity)}`
          : ""
      }
    </div>`;
  if (scroll) p.el.querySelector(".list").scrollTop = scroll;

  wire(side, items);
  updateArrows();
}

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );

function wire(side, items) {
  const p = S[side];

  p.el.querySelectorAll(".crumb").forEach((b) => {
    b.onclick = () => {
      if (!canBrowse(side)) return;
      clearToast();
      p.stack = p.stack.slice(0, +b.dataset.go);
      refresh(side);
    };
  });
  p.el.querySelectorAll(".col").forEach((b) => {
    b.onclick = () => {
      const k = b.dataset.sort;
      // A column opens at the end people reach for it: names from A, but the
      // biggest files and the newest changes. Clicking again flips it.
      p.sort =
        p.sort.key === k ? { key: k, dir: -p.sort.dir } : { key: k, dir: k === "name" ? 1 : -1 };
      render(side);
    };
  });
  const change = p.el.querySelector("#change-dir");
  if (change) change.onclick = pickMacFolder;
  const del = p.el.querySelector('[data-act="delete"]');
  if (del) del.onclick = () => deleteSelection(side);
  const ren = p.el.querySelector('[data-act="rename"]');
  if (ren) ren.onclick = renameSelection;
  const mkdir = p.el.querySelector('[data-act="mkdir"]');
  if (mkdir) mkdir.onclick = () => newFolder(side);
  const unplug = p.el.querySelector('[data-act="disconnect"]');
  if (unplug)
    unplug.onclick = () => {
      // close() would queue behind the running transfer, and the files after
      // it would then fail one by one against a closed device.
      if (running || expanding) return;
      disconnect();
    };
  const reload = p.el.querySelector('[data-act="refresh"]');
  if (reload)
    reload.onclick = async () => {
      // A phone listing would queue behind the running transfer.
      if (side === "phone" && (running || expanding)) return;
      clearToast();
      if (side === "phone") await refreshStorage();
      refresh(side, true);
    };

  p.el.querySelectorAll(".row").forEach((r) => {
    const name = r.dataset.n;
    const item = items.find((i) => i.name === name);
    if (!item) return;

    const enter = () => {
      if (!canBrowse(side)) return;
      clearToast();
      p.stack.push({ name, handle: item.handle });
      p.anchor = null;
      refresh(side);
    };

    r.onclick = (e) => {
      clearOther(side);
      if (e.metaKey || e.ctrlKey) {
        p.sel.has(name) ? p.sel.delete(name) : p.sel.add(name);
        p.anchor = name;
      } else if (e.shiftKey && p.anchor != null) {
        const a = items.findIndex((i) => i.name === p.anchor),
          b = items.findIndex((i) => i.name === name);
        if (a < 0) {
          p.sel.clear();
          p.sel.add(name);
          p.anchor = name;
        } else {
          // Shift replaces the selection with the range, as Finder does;
          // the anchor stays put so you can keep extending from it.
          p.sel.clear();
          items.slice(Math.min(a, b), Math.max(a, b) + 1).forEach((i) => p.sel.add(i.name));
        }
      } else {
        p.sel.clear();
        p.sel.add(name);
        p.anchor = name;
      }
      render(side);
      focusRow(side, name);
    };
    r.ondblclick = () => {
      if (item.isDir) enter();
    };
    r.onkeydown = (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const i = items.findIndex((x) => x.name === name);
        const j = Math.max(0, Math.min(items.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        const target = items[j].name;

        if (e.shiftKey) {
          if (p.anchor == null) p.anchor = name;
          const a = items.findIndex((x) => x.name === p.anchor);
          p.sel.clear();
          items.slice(Math.min(a, j), Math.max(a, j) + 1).forEach((x) => p.sel.add(x.name));
        } else {
          p.sel.clear();
          p.sel.add(target);
          p.anchor = target;
        }
        clearOther(side);
        render(side);
        focusRow(side, target);
        return;
      }
      // Enter renames, as in Finder; that exists on the phone side only.
      if (e.key === "Enter" && side === "phone") {
        if (!p.sel.has(name)) {
          p.sel = new Set([name]);
          p.anchor = name;
          clearOther(side);
          render(side);
        }
        renameSelection();
      }
    };
  });

  // Clicking the header clears the selection, as clicking empty space in the
  // list does. Buttons and breadcrumbs keep their own job.
  p.el.querySelector(".pane-top").onclick = (e) => {
    if (e.target.closest("button") || !p.sel.size) return;
    clearSelection(side);
    p.el.querySelector(".list").focus({ preventScroll: true });
  };

  const list = p.el.querySelector(".list");
  list.onclick = (e) => {
    if (e.target !== list && !e.target.classList.contains("empty")) return;
    list.focus({ preventScroll: true });
    if (!p.sel.size) return;
    clearSelection(side);
    S[side].el.querySelector(".list").focus({ preventScroll: true });
  };
}

function copyDirection() {
  if (S.mac.sel.size) return { from: "mac", to: "phone", icon: ICON.arrow };
  if (S.phone.sel.size) return { from: "phone", to: "mac", icon: ICON.back };
  return null;
}

// Which pane a shortcut applies to: whatever holds focus, else whatever
// holds a selection.
function focusedSide() {
  const el = document.activeElement;
  if (el && S.mac.el.contains(el)) return "mac";
  if (el && S.phone.el.contains(el)) return "phone";
  if (S.mac.sel.size) return "mac";
  if (S.phone.sel.size) return "phone";
  return null;
}

// Keyboard navigation. Opening a folder or going back up re-renders the
// pane, which drops the focus, so both land on a row again: the first one
// after opening, the folder just left after going up. With no row to land
// on, the list itself takes the focus so the next key still reaches the pane.
async function openFolder(side) {
  const p = S[side];
  if (p.busy || p.sel.size !== 1 || !canBrowse(side)) return;
  const item = p.entries.find((i) => p.sel.has(i.name));
  if (!item?.isDir) return;
  clearToast();
  p.stack.push({ name: item.name, handle: item.handle });
  await reading(side);
  landOn(side, sorted(p)[0]?.name);
}

// Allowed while a listing is still running, like the breadcrumb.
async function closeFolder(side) {
  const p = S[side];
  if (!p.stack.length || !canBrowse(side)) return;
  clearToast();
  const from = p.stack.pop().name;
  await reading(side);
  landOn(side, from);
}

// Starts the listing, and keeps the focus in the pane meanwhile so that a
// further ← or → still reaches it.
function reading(side) {
  const done = refresh(side);
  S[side].el.querySelector(".list").focus({ preventScroll: true });
  return done;
}

function landOn(side, name) {
  const p = S[side];
  p.anchor = null;
  if (name && p.entries.some((i) => i.name === name)) {
    p.sel = new Set([name]);
    p.anchor = name;
    clearOther(side);
    render(side);
    focusRow(side, name);
  } else {
    p.el.querySelector(".list").focus({ preventScroll: true });
  }
}

function selectAll(side) {
  const p = S[side];
  if (!p.entries.length) return;
  p.sel = new Set(p.entries.map((i) => i.name));
  p.anchor = null;
  clearOther(side);
  render(side);
}

function focusRow(side, name) {
  const el = S[side].el.querySelector(`.row[data-n="${CSS.escape(name)}"]`);
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest" });
}

// Only one pane can hold a selection, since the single copy button needs an
// unambiguous source.
function clearOther(side) {
  clearSelection(side === "mac" ? "phone" : "mac");
}

function clearSelection(side) {
  const p = S[side];
  if (!p.sel.size) return;
  p.sel.clear();
  p.anchor = null;
  render(side);
}

function updateArrows() {
  syncTools("mac");
  syncTools("phone");
  const dir = copyDirection();
  const busy = running || expanding || queue.some((t) => t.state === "live");
  const btn = $("copy");
  const noDest = dir?.to === "mac" && !S.mac.root;
  btn.disabled = busy || !dir || !mtp || noDest;
  btn.classList.toggle("busy", busy);
  btn.classList.toggle("to-mac", busy && batchTo === "mac");
  btn.title = busy
    ? "Copying"
    : noDest
      ? "Choose a Mac folder first"
      : dir
        ? `Copy to ${dir.to === "phone" ? "phone" : "Mac"} (C)`
        : "Select files to copy";
  btn.querySelector(".go-label").textContent = busy ? "Copying" : "Copy";
  // Empty rather than hidden: the rows keep their height so the label
  // sits in the same place either way. Rewritten only on change, since this
  // runs on every progress tick and a new element restarts the spin.
  const glyph = busy ? (batchTo === "phone" ? ICON.arrow : ICON.back) : dir ? dir.icon : "";
  if ($("copy-arrow").dataset.glyph !== glyph) {
    $("copy-arrow").dataset.glyph = glyph;
    $("copy-arrow").innerHTML = glyph ? icon(glyph) : "";
  }
  $("copy-count").textContent = busy ? batchPercent() : dir ? String(S[dir.from].sel.size) : "";
}

// Byte progress of the queue, which holds only the current batch while it
// runs. Failed files count as finished. Empty until sizes are known.
function batchPercent() {
  let total = 0;
  let done = 0;
  for (const t of queue) {
    total += t.total;
    done += isFinished(t) ? t.total : t.done;
  }
  return total ? `${Math.floor((done / total) * 100)}%` : "";
}

/* ------------------------------------------------------------------ */
/* transfer queue                                                      */
/* ------------------------------------------------------------------ */

const queue = [];
let running = false;
let aborting = false;
let expanding = false;
let batchTo = null; // direction of the running copy, once the selection is gone
let transferred = 0;
let batchT0 = 0;
let rate = 0;

// Observed: Chrome's File System Access layer intermittently throws these when
// many files in one directory are handled in quick succession. A short pause
// and another attempt clears it.
const TRANSIENT = new Set(["InvalidStateError", "NotReadableError"]);
const MAX_TRIES = 3;

// Only the transfer rows in view, plus two beyond each edge, are in the DOM;
// spacers stand in for the rest. Row height comes from the stylesheet, so
// the two cannot drift apart.
const ROW_H = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--q-row"));
const Q_PAD = parseFloat(getComputedStyle($("q-body")).paddingTop);
const rowTop = (i) => Q_PAD + i * ROW_H;
let followLive = false; // keep the copying row in view; off once it is scrolled out of view

function drawQueue() {
  const done = queue.filter((t) => t.state === "done").length;
  const failed = queue.filter((t) => t.state === "fail").length;
  const stopped = queue.filter((t) => t.state === "stopped").length;
  const pending = queue.filter((t) => t.state === "wait" || t.state === "live").length;

  $("q-sum").textContent = expanding
    ? "Preparing…"
    : pending
      ? [`${done} of ${queue.length} copied`, rate && fmtSize(rate) + "/s"]
          .filter(Boolean)
          .join(" · ")
      : [done && `${done} copied`, failed && `${failed} failed`, stopped && `${stopped} stopped`]
          .filter(Boolean)
          .join(" · ");
  $("queue").classList.toggle("active", running || expanding);
  $("q-stop").hidden = !running;
  // Stop takes effect between files; the current one always finishes.
  $("q-stop").disabled = aborting; // re-enabled for the next batch
  $("q-stop").textContent = aborting ? "Stopping…" : "Stop";
  $("q-clear").disabled = running || expanding || !queue.some(isFinished);

  const body = $("q-body");
  if (!queue.length) {
    body.innerHTML = "";
    return;
  }

  const view = body.clientHeight;
  const live = queue.findIndex((t) => t.state === "live");
  if (followLive && live >= 0) {
    const top = rowTop(live);
    if (top < body.scrollTop) body.scrollTop = top;
    else if (top + ROW_H > body.scrollTop + view) body.scrollTop = top + ROW_H - view;
  }
  // Two rows beyond each edge, so a small scroll does not pop rows in at the edge.
  const first = Math.max(0, Math.floor((body.scrollTop - Q_PAD) / ROW_H) - 2);
  const last = Math.min(queue.length, Math.ceil((body.scrollTop - Q_PAD + view) / ROW_H) + 2);
  // Rows are rebuilt on every progress tick, which restarts their spin. A
  // negative delay from the clock resumes it at the current angle instead.
  body.style.setProperty("--spin-phase", `-${Math.round(performance.now() % 1400)}ms`);
  body.style.setProperty("--q-digits", String(queue.length).length);
  const rows = queue
    .slice(first, last)
    .map((t, i) => {
      const pct = t.total
        ? Math.min(100, Math.round((t.done / t.total) * 100))
        : t.state === "done"
          ? 100
          : 0;
      // One glyph per state.
      const glyph =
        t.state === "done"
          ? ICON.check
          : t.state === "fail"
            ? ICON.warn
            : t.state === "stopped"
              ? ICON.close
              : t.state === "live"
                ? ICON.busy
                : ICON.waiting;
      // A live row at 100% has sent everything and waits for the phone to
      // confirm; only then does it turn done.
      const stat =
        t.state === "fail"
          ? "Failed"
          : t.state === "stopped"
            ? "Stopped"
            : t.state === "done"
              ? "100%"
              : t.state === "live"
                ? pct === 100
                  ? "Saving…"
                  : `${pct}%`
                : "";
      return `
      <div class="q-row ${t.state}" ${t.error ? `title="${esc(t.error)}"` : ""}>
        <div class="q-n">${first + i + 1}</div>
        ${icon(glyph)}
        <div class="q-name">${esc(t.label)}</div>
        <div class="q-size">${fmtSize(t.total)}</div>
        <div class="bar"><span style="width:${pct}%"></span></div>
        <div class="q-stat">${stat}</div>
      </div>`;
    })
    .join("");
  body.innerHTML = `<div style="height:${first * ROW_H}px"></div>${rows}<div style="height:${(queue.length - last) * ROW_H}px"></div>`;
  updateArrows();
}

function isFinished(t) {
  return t.state === "done" || t.state === "fail" || t.state === "stopped";
}

// Drops finished rows, keeps anything still queued or running.
function clearFinished() {
  for (let i = queue.length - 1; i >= 0; i--) if (isFinished(queue[i])) queue.splice(i, 1);
}

async function startCopy(from, to) {
  const src = S[from];
  const names = [...src.sel];
  if (!names.length || !mtp || expanding || running || src.busy || (to === "mac" && !S.mac.root))
    return;
  clearToast();
  const items = src.entries.filter((i) => names.includes(i.name));
  src.sel.clear();
  render(from);
  clearFinished();

  // Snapshot the destination so later navigation can't redirect a running copy.
  const root = { handle: to === "phone" ? phoneParent() : macDir() };

  // Flatten folders into one task per file before copying anything. Copying a
  // folder as a single task meant one unreadable file failed the whole tree,
  // abandoned every file after it, and reported it under the folder's name,
  // which is exactly how a half-finished copy looks finished.
  batchTo = to;
  expanding = true;
  updateArrows();
  drawQueue();

  const abandon = (what, err) => {
    fail(what, err);
    expanding = false;
    drawQueue();
    updateArrows();
  };

  const plan = { tasks: [], dirs: [] };
  try {
    const existing = to === "phone" ? await listMap(root.handle) : await kindMap(root.handle);
    for (const item of items) {
      if (to === "phone") await expandPush(item, root, plan, "", existing);
      else await expandPull(item, root, plan, "", existing);
    }
  } catch (e) {
    // Copying a partial list would leave a partial tree that looks complete.
    return abandon("Could not prepare the copy", e);
  }

  // Reading a big Mac folder takes long enough for the phone to have been
  // unplugged meanwhile, which nulls `storage`.
  if (to === "phone") await refreshStorage();
  if (!storage)
    return abandon("Could not prepare the copy", { message: "The phone was disconnected." });

  // Refuse a copy that cannot fit rather than fail partway through it. A
  // replace uploads the new file before the old one goes, so it needs its
  // whole size too.
  if (to === "phone") {
    const need = plan.tasks.reduce((a, t) => a + t.total, 0);
    if (need > storage.free)
      return abandon("Not enough space on the phone", {
        message: `This copy needs ${fmtSize(need)}, and the phone has ${fmtSize(storage.free)} free.`,
      });
  }

  const clashes = plan.tasks.filter((t) => t.exists);
  if (clashes.length) {
    // confirm() blocks painting, so show the idle state first; otherwise the
    // button keeps spinning behind the question.
    expanding = false;
    drawQueue();
    updateArrows();
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    if (!confirm(clashPrompt(clashes, to))) return;
    expanding = true;
    updateArrows();
    drawQueue();
  }

  // Missing folders are created only now, so a cancelled copy leaves none behind.
  // Parents precede their children in plan.dirs.
  try {
    for (const d of plan.dirs)
      d.handle =
        to === "phone"
          ? await mtp.createFolder(storage.id, d.parent.handle, d.name)
          : await d.parent.handle.getDirectoryHandle(d.name, { create: true });
    for (const t of plan.tasks) queue.push({ ...t, done: 0, state: "wait", tries: 0 });
  } catch (e) {
    fail("Could not create the folders", e); // pump() still refreshes both sides
  } finally {
    expanding = false;
  }
  drawQueue();
  updateArrows();
  pump();
}

function clashPrompt(clashes, to) {
  const n = clashes.length;
  const where = to === "phone" ? "the phone" : "this Mac";
  const names = clashes
    .slice(0, 2)
    .map((t) => `“${t.label}”`)
    .join(", ");
  const found =
    n === 1
      ? `${names} already exists on ${where}.`
      : `${n} files already exist on ${where}: ${names}${n > 2 ? ` and ${n - 2} more` : ""}.`;
  const ask =
    to === "phone" && !mtp.supports(OP.SetObjectPropValue)
      ? "This phone can’t replace files, so the copies get a number added. Continue?"
      : `Replace ${n === 1 ? "it" : "them"}?`;
  return `${found} ${ask}`;
}

// Key for the clash maps. Android's external storage is defined as
// case-insensitive [Storage] and Mac volumes are by default, so "photo.jpg"
// would silently overwrite "Photo.jpg"; APFS also ignores the Unicode form.
// Judging the clash on this key asks once too often at worst.
const fold = (name) => name.normalize("NFC").toLowerCase();

// "IMG.jpg" -> "IMG (1).jpg", or the first number not already taken.
function freeName(name, taken) {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; ; i++) {
    const n = `${base} (${i})${ext}`;
    if (!taken.has(fold(n))) return n;
  }
}

async function kindMap(dir) {
  const m = new Map();
  for await (const [name, h] of dir.entries()) m.set(fold(name), h.kind);
  return m;
}

// Children of a phone folder, by folded name.
async function listMap(parent) {
  const m = new Map();
  for (const e of await mtp.list(storage.id, parent)) m.set(fold(e.name), e);
  return m;
}

// `parent` is a destination folder as { handle }. A missing folder gets
// { parent, name, handle: null } and goes into plan.dirs for startCopy to
// create, so an empty folder is still created although it contributes no
// tasks. expandPull does the same.
async function expandPush(entry, parent, plan, prefix, existing) {
  const clash = existing.get(fold(entry.name));

  if (!entry.isDir) {
    const exists = !!clash && !clash.isDir;
    // Replacing safely needs rename; without it, keep both files.
    const keepBoth = exists && !mtp.supports(OP.SetObjectPropValue);
    plan.tasks.push({
      to: "phone",
      name: keepBoth ? freeName(entry.name, existing) : entry.name,
      label: prefix + entry.name,
      handle: entry.handle,
      dest: parent,
      exists,
      replace: exists && !keepBoth ? clash.handle : null,
      // Children of a folder carry no size yet; an unreadable one fails later.
      total:
        entry.size ??
        (await entry.handle.getFile().then(
          (f) => f.size,
          () => 0,
        )),
    });
    return;
  }

  // Reuse a folder that is already there. Unconditionally creating one is
  // what left duplicate folders on the phone.
  let dir, childExisting;
  if (clash && clash.isDir) {
    dir = { handle: clash.handle };
    childExisting = await listMap(dir.handle);
  } else {
    dir = { parent, name: entry.name, handle: null };
    plan.dirs.push(dir);
    childExisting = new Map();
  }

  for await (const [name, h] of entry.handle.entries()) {
    if (name.startsWith(".")) continue;
    await expandPush(
      { name, isDir: h.kind === "directory", handle: h },
      dir,
      plan,
      `${prefix}${entry.name}/`,
      childExisting,
    );
  }
}

async function expandPull(entry, parent, plan, prefix, existing) {
  const clash = existing.get(fold(entry.name));
  if (!entry.isDir) {
    plan.tasks.push({
      to: "mac",
      name: entry.name,
      label: prefix + entry.name,
      handle: entry.handle,
      dest: parent,
      exists: clash === "file",
      total: entry.size || 0,
    });
    return;
  }
  let dir, childExisting;
  if (clash === "directory") {
    dir = { handle: await parent.handle.getDirectoryHandle(entry.name, { create: true }) };
    childExisting = await kindMap(dir.handle);
  } else {
    dir = { parent, name: entry.name, handle: null };
    plan.dirs.push(dir);
    childExisting = new Map();
  }
  for (const child of await mtp.list(storage.id, entry.handle)) {
    await expandPull(child, dir, plan, `${prefix}${entry.name}/`, childExisting);
  }
}

async function pump() {
  if (running) {
    console.warn("pump() skipped: a batch is still running");
    return;
  }
  running = true;
  aborting = false;
  transferred = 0;
  batchT0 = performance.now();
  rate = 0;
  followLive = true;
  $("q-body").scrollTop = 0;
  updateArrows();

  const failed = []; // this batch only; the queue also holds earlier batches' failures
  while (true) {
    const task = queue.find((t) => t.state === "wait");
    if (!task) break;
    task.state = "live";
    drawQueue();

    try {
      // An unplugged phone stops the batch, or a reconnect would run the rest
      // against a new session whose handles number different objects.
      if (aborting || !mtp) throw new DOMException("Stopped", "AbortError");
      if (task.to === "phone") await pushFile(task);
      else await pullFile(task);
      task.state = "done";
      task.done = task.total;
    } catch (e) {
      task.tries++;
      // A stalled phone stays stalled until replugged, and Chrome marks an
      // unplugged device as closed before the disconnect event arrives
      // [Blink OnConnectionError]; either way the remaining files would only
      // fail one by one.
      if (e?.message === STALLED || !mtp?.dev.opened) aborting = true;
      if (e?.name === "AbortError") {
        task.state = "stopped";
      } else if (task.tries < MAX_TRIES && TRANSIENT.has(e?.name)) {
        task.state = "wait";
        task.done = 0;
        await new Promise((r) => setTimeout(r, 250 * task.tries));
      } else {
        task.state = "fail";
        task.error = e?.message || String(e);
        failed.push(task);
      }
    }
    drawQueue();
    if (aborting || !mtp) {
      for (const t of queue) if (t.state === "wait") t.state = "stopped";
      break;
    }
  }

  running = false;
  aborting = false;
  drawQueue();

  if (failed.length) {
    if (failed.length === 1) {
      // One failure: say what went wrong rather than where to go looking.
      fail(`Could not copy ${failed[0].label}`, {
        message: failed[0].error || "No reason reported.",
      });
    } else {
      const names = failed
        .slice(0, 3)
        .map((t) => `${t.label} (${t.error || "no reason"})`)
        .join("; ");
      const more = failed.length > 3 ? `, and ${failed.length - 3} more` : "";
      fail(`${failed.length} files could not be copied`, { message: names + more });
    }
  }

  await refresh("mac", true);
  await refreshStorage();
  await refresh("phone", true);
  updateArrows();
}

// Rate is measured across the whole batch; per-file timing is meaningless
// when a batch is thousands of small files.
function onProgress(task) {
  let last = 0;
  return (done, total) => {
    task.done = done;
    if (total && total !== Infinity) task.total = total;
    transferred += done - last;
    last = done;
    const dt = (performance.now() - batchT0) / 1000;
    if (dt > 0.4) rate = Math.round(transferred / dt);
    throttledDraw();
  };
}

let drawPending = false;
function throttledDraw() {
  if (drawPending) return;
  drawPending = true;
  requestAnimationFrame(() => {
    drawPending = false;
    drawQueue();
  });
}

/* ---- Mac -> phone ---- */

async function pushFile(task) {
  const file = await task.handle.getFile();
  task.total = file.size;

  if (task.replace == null) {
    await upload(task, file, task.name);
    return;
  }

  // MTP has no overwrite, and Android refuses to rename onto a name that
  // exists [MtpStorageManager beginRenameObject]. So: upload under a temporary
  // name, move the original aside, rename the upload into place, delete the
  // original. It is never gone before the new file is in place, and a failed
  // step leaves it under its own name or the backup name.
  const temp = `.droidtmp-${task.name}`;
  const backup = `.droidbak-${task.name}`;
  const handle = await upload(task, file, temp);
  try {
    await mtp.renameObject(task.replace, backup);
  } catch (e) {
    await mtp.deleteObject(handle).catch(() => {});
    throw e;
  }
  try {
    await mtp.renameObject(handle, task.name);
  } catch (e) {
    await mtp.deleteObject(handle).catch(() => {});
    try {
      await mtp.renameObject(task.replace, task.name);
    } catch {
      throw new Error(
        `The phone could not rename the file. The original is still there as ${backup}.`,
      );
    }
    throw e;
  }
  try {
    await mtp.deleteObject(task.replace);
  } catch {
    throw new Error(
      `Copied, but the old file could not be removed and is still there as ${backup}.`,
    );
  }
}

// Returns the new object's handle.
async function upload(task, file, name) {
  const reader = file.stream().getReader();
  try {
    const { handle } = await mtp.writeObject(
      storage.id,
      task.dest.handle,
      name,
      file.size,
      new Date(file.lastModified),
      async (write) => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await write(value);
        }
      },
      onProgress(task),
    );
    return handle;
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
}

/* ---- phone -> Mac ---- */

async function pullFile(task) {
  const fh = await task.dest.handle.getFileHandle(task.name, { create: true });
  const ws = await fh.createWritable();
  try {
    await mtp.readObject(task.handle, task.total, (chunk) => ws.write(chunk), onProgress(task));
    await ws.close();
  } catch (e) {
    // Leaves no .crswap behind; without this an aborted write strands one.
    try {
      await ws.abort();
    } catch {}
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* new folder                                                          */
/* ------------------------------------------------------------------ */

// Creates it in the folder the pane is showing, on either side.
async function newFolder(side) {
  const p = S[side];
  if (p.busy || running || expanding || !(side === "mac" ? p.root : storage)) return;
  clearToast();
  const where = side === "mac" ? "this Mac" : "the phone";
  const name = prompt(`Name of the new folder on ${where}:`, "Untitled folder")?.trim();
  if (!name) return;
  // A slash is not part of a name, and a dot-folder would be hidden from the
  // Mac listing. That also rules out "." and "..", which Chrome refuses.
  if (name.startsWith(".") || name.includes("/"))
    return fail("Could not create the folder", {
      message: "A name cannot start with a dot or contain a slash.",
    });
  // Both sides ignore case, so a name differing from an existing one only in
  // case or Unicode form would land on that folder instead of a new one.
  const taken = p.entries.find((e) => fold(e.name) === fold(name));
  if (taken)
    return fail("Could not create the folder", {
      message: `“${taken.name}” already exists in this folder.`,
    });

  const parent = side === "mac" ? macDir() : phoneParent();
  p.busy = true;
  render(side);
  try {
    if (side === "mac") await parent.getDirectoryHandle(name, { create: true });
    else await mtp.createFolder(storage.id, parent, name);
    // Selected like a new folder in Finder, ready to open or rename.
    p.sel = new Set([name]);
    p.anchor = name;
    clearOther(side);
  } catch (e) {
    fail(`Could not create ${name}`, e);
  }
  p.busy = false;
  await refresh(side, true);
  focusRow(side, name); // does nothing if the folder was not created
}

/* ------------------------------------------------------------------ */
/* rename                                                              */
/* ------------------------------------------------------------------ */

// Phone side only: Chrome offers no rename for local folders.
async function renameSelection() {
  const p = S.phone;
  if (running || expanding || p.busy || p.sel.size !== 1) return;
  const item = p.entries.find((i) => p.sel.has(i.name));
  if (!item) return;
  clearToast();
  const name = prompt(`Rename “${item.name}” to:`, item.name)?.trim();
  if (!name || name === item.name) return;
  if (name.includes("/"))
    return fail(`Could not rename ${item.name}`, { message: "A name cannot contain a slash." });
  // Android refuses a new name only when it matches an existing one exactly
  // [MtpStorageManager beginRenameObject], but its storage is case-insensitive
  // [Storage], so a name differing from another file's only in case or Unicode
  // form would replace that file. Refuse it here; an exact match the phone
  // refuses itself.
  const taken = p.entries.find((e) => e !== item && e.name !== name && fold(e.name) === fold(name));
  if (taken)
    return fail(`Could not rename ${item.name}`, {
      message: `“${name}” already exists in this folder as “${taken.name}”.`,
    });

  p.busy = true;
  render("phone");
  try {
    await mtp.renameObject(item.handle, name);
    p.sel = new Set([name]);
  } catch (e) {
    fail(`Could not rename ${item.name}`, e);
  }
  p.busy = false;
  await refresh("phone", true);
}

/* ------------------------------------------------------------------ */
/* delete                                                              */
/* ------------------------------------------------------------------ */

async function deleteSelection(side) {
  const p = S[side];
  if (running || expanding || p.busy) return;
  const items = p.entries.filter((i) => p.sel.has(i.name));
  if (!items.length) return;
  clearToast();
  // Snapshot the folder: the breadcrumb stays clickable while this runs, and
  // Mac entries are removed by name.
  const dir = side === "mac" ? macDir() : null;

  const what = items.length === 1 ? `“${items[0].name}”` : `${items.length} items`;
  const folders = items.filter((i) => i.isDir).length;
  const warning = folders
    ? ` This includes ${folders === 1 ? "a folder" : folders + " folders"} and everything inside.`
    : "";
  const where = side === "mac" ? "this Mac" : "the phone";
  if (!confirm(`Delete ${what} from ${where}?${warning} It skips the Trash and cannot be undone.`))
    return;

  p.busy = true;
  render(side);

  const failed = [];
  for (const it of items) {
    try {
      if (side === "mac") {
        await dir.removeEntry(it.name, { recursive: true });
      } else {
        // Android deletes a folder's contents with it [MtpUtils deletePath].
        await mtp.deleteObject(it.handle);
      }
    } catch (e) {
      failed.push(`${it.name} (${e?.message || e})`);
    }
  }

  if (side === "phone") await refreshStorage();
  p.busy = false;
  await refresh(side);
  if (failed.length) {
    fail(`${failed.length} item${failed.length > 1 ? "s" : ""} could not be deleted`, {
      message: failed.slice(0, 3).join("; "),
    });
  }
}

/* ------------------------------------------------------------------ */
/* connect                                                             */
/* ------------------------------------------------------------------ */

async function pickMacFolder() {
  // A copy holds the folder it started in, so swapping it now would only make
  // the pane disagree with where the files are going.
  if (running || expanding) return;
  clearToast();
  try {
    const dir = await window.showDirectoryPicker({
      mode: "readwrite",
      id: "droidfiletransfer-mac",
      startIn: "documents",
    });
    S.mac.root = dir;
    S.mac.stack = [];
    await saveDir(dir);
    await refresh("mac");
  } catch (e) {
    if (e.name !== "AbortError") fail("Could not open that folder", e);
  }
}

async function restoreMacFolder() {
  const dir = await loadDir();
  if (!dir) return false;
  const perm = await dir.queryPermission({ mode: "readwrite" });
  if (perm !== "granted") return false;
  S.mac.root = dir;
  return true;
}

async function connect() {
  clearToast();
  let device;
  try {
    device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
  } catch (e) {
    if (e.name !== "NotFoundError") fail("Could not open the device chooser", e);
    return;
  }
  await attach(device);
}

// An attempt takes seconds, so the button carries it and takes no clicks
// meanwhile: an automatic one would leave the connect screen looking idle.
function pickBusy(on) {
  const btn = $("pick");
  btn.disabled = on;
  btn.textContent = on ? "Connecting…" : "Choose phone";
}

let attaching = false; // true while a connection attempt runs

// WebUSB transfers never time out on their own. A phone that is locked or in
// the wrong USB mode can accept the claim and then never answer, which would
// otherwise leave the connection attempt pending forever. A healthy phone
// answers within a second.
const OPEN_TIMEOUT = 5000;

// Every failure is reported, whether a click or the app started the attempt: a
// silent one leaves the connect screen up with no reason why. Only one attempt
// runs at a time, since closing the device under a running one cancels its
// transfer and strands the phone's responder until a replug.
async function attach(device) {
  if (mtp) return;
  if (attaching) {
    console.warn("attach ignored: a connection attempt is already running");
    return;
  }
  const m = new Mtp(device);
  attaching = true;
  pickBusy(true);
  let timer;
  try {
    const info = await Promise.race([
      m.open(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "The phone did not respond. Unplug and replug the cable, unlock the " +
                  "phone, choose File transfer in its USB notification, then click Choose phone.",
              ),
            ),
          OPEN_TIMEOUT,
        );
      }),
    ]);
    clearTimeout(timer);
    mtp = m;

    // Observed: Android often answers the first GetStorageIDs with an empty
    // list right after the session opens. Give it a moment rather than
    // declaring the phone empty.
    let ids = [];
    for (let attempt = 0; attempt < 6 && !ids.length; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 500));
      ids = await m.getStorageIDs();
    }
    if (!ids.length)
      throw new Error(
        "The phone is connected but shows no storage. Unlock it, and in its USB " +
          "notification switch to Charging and back to File transfer, then click Choose phone.",
      );
    storage = await m.getStorageInfo(ids[0]);

    S.phone.label = [info.manufacturer, info.model].filter(Boolean).join(" ") || "Phone";
    S.phone.stack = [];

    // Firmware and serial matter only when a device misbehaves, so they live
    // on the name's tooltip rather than taking up the pane header. The name
    // leads, since a narrow pane cuts it short in the header itself.
    S.phone.tip = [
      S.phone.label,
      info.version && `Firmware ${info.version}`,
      info.serial && `Serial ${info.serial}`,
    ]
      .filter(Boolean)
      .join("\n");

    clearToast(); // a failed earlier attempt no longer applies once connected
    $("connect").hidden = true;
    $("work").hidden = false;
    $("queue").hidden = false;
    drawQueue(); // sets Clear's state for the new session

    // Only restore silently. showDirectoryPicker() throws without transient
    // user activation [FSA], which an automatic reconnect does not have, and
    // which a click cannot guarantee either: it counts for only a few seconds,
    // and the device chooser and OpenSession come first. The pane's own
    // "Choose folder" button is a real click, and works.
    if (!S.mac.root) await restoreMacFolder();
    await refresh("mac");
    await refresh("phone");
  } catch (e) {
    clearTimeout(timer);
    // release(), not close(): close() sends CloseSession, and a device that
    // just timed out will not answer that either -- which used to hang here
    // and leave every later connection attempt blocked.
    await m.release();
    mtp = null;
    fail("Could not connect to the phone", e);
  } finally {
    attaching = false;
    pickBusy(false);
  }
}

async function disconnect() {
  if (mtp) {
    try {
      await mtp.close();
    } catch {}
  }
  mtp = null;
  storage = null;
  S.phone.entries = [];
  S.phone.stack = [];
  S.phone.sel.clear();
  $("work").hidden = true;
  $("queue").hidden = true;
  $("connect").hidden = false;
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

// Spec names are accurate but rarely actionable. Where a failure has a known
// remedy, say the remedy; otherwise fall back to what the device reported.
function advise(err) {
  const msg = err?.message || String(err);

  // The remedy has to be read at a glance, so each platform gets only its own.
  // Another tab of this page has its own message, from the Web Lock in open().
  if (/claim/i.test(msg))
    return navigator.userAgentData?.platform === "Linux"
      ? "Another app is using the phone. Eject it in Files, quit whatever opened it, then click " +
          "Choose phone. If nothing is open, unplug and replug the cable."
      : "Another app is using the phone. Quit Image Capture, Photos, Preview, Android File " +
          "Transfer, OpenMTP, Google Drive or Dropbox, then click Choose phone. If none are open, " +
          "unplug and replug the cable.";
  if (err?.name === "NetworkError" || /disconnect|no device|device unavailable/i.test(msg))
    return "The phone was disconnected. Check the cable, then click Choose phone.";
  if (err?.name === "QuotaExceededError") return "This Mac is out of disk space.";
  if (err?.name === "NotAllowedError")
    return "Access to that folder was withdrawn. Choose the folder again.";

  // MTP response codes [mtp.h MTP_RESPONSE_*].
  switch (err?.code) {
    case 0x2003:
      return "The phone ended the session. Unlock it, then click Choose phone.";
    case 0x200c:
      return "The phone is out of space.";
    case 0x200d:
      return "That file on the phone is write-protected.";
    case 0x200e:
      return "That location on the phone is read-only.";
    case 0x200f:
      return "The phone refused access to that file.";
    case 0x2002:
      // General error, Android's catch-all. What it means depends on what was being done.
      return err.op === OP.SendObjectInfo || err.op === OP.SendObject
        ? "The phone rejected the file. The name may already exist, or contain characters it does not allow."
        : err.op === OP.SetObjectPropValue
          ? "The phone could not rename the file, so the original was kept."
          : "The phone reported an error. The file may have been moved or deleted.";
  }
  return msg;
}

// A message belongs to the last action, so every new one starts clean.
function clearToast() {
  document.querySelector(".toast")?.remove();
}

function fail(what, err) {
  console.error(what, err);
  clearToast();
  const detail = advise(err);
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${icon(ICON.warn)}<p><b>${esc(what)}</b>${esc(detail)}</p><button aria-label="Dismiss">${icon(ICON.close)}</button>`;
  el.querySelector("button").onclick = () => el.remove();
  document.body.append(el); // stays until dismissed or replaced
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

$("pick").onclick = connect;
document.addEventListener("keydown", (e) => {
  if ($("help-dialog").open) return; // Esc closes it; the panes get nothing
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
    const side = focusedSide();
    if (!side) return;
    e.preventDefault(); // otherwise the browser selects the page text
    selectAll(side);
    return;
  }
  // A disabled button ignores click(), so this obeys the button's own state.
  if (e.key.toLowerCase() === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    $("copy").click();
    return;
  }
  if (e.key === "Escape") {
    const side = focusedSide();
    if (side) clearSelection(side);
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    const side = focusedSide();
    if (side) deleteSelection(side);
  }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    const side = focusedSide();
    if (!side) return;
    e.preventDefault();
    if (e.key === "ArrowRight") openFolder(side);
    else closeFolder(side);
  }
});
// Clicking outside both panes clears the selection, except on controls. A
// detached target was re-rendered by a pane's own click handler.
document.addEventListener("click", (e) => {
  if (!e.target.isConnected || e.target.closest(".pane, button, a, dialog")) return;
  clearSelection("mac");
  clearSelection("phone");
});

$("help").onclick = () => $("help-dialog").showModal();
$("help-close").onclick = () => $("help-dialog").close();
// Closing returns the focus to the Help button, which after Esc shows a
// focus ring; nothing is gained by keeping the focus there.
$("help-dialog").onclose = () => $("help").blur();
// A click on the dimmed backdrop lands on the dialog element itself.
$("help-dialog").onclick = (e) => {
  if (e.target === $("help-dialog")) $("help-dialog").close();
};

$("copy").onclick = () => {
  const dir = copyDirection();
  if (dir) startCopy(dir.from, dir.to);
};
$("q-stop").onclick = () => {
  aborting = true;
  $("q-stop").disabled = true;
};

$("q-clear").onclick = () => {
  clearFinished();
  drawQueue();
};
// Scrolling and resizing redraw the rows in view. Following the copying row
// stops when it is scrolled out of view and resumes when it is scrolled back in.
$("q-body").addEventListener(
  "scroll",
  () => {
    const live = queue.findIndex((t) => t.state === "live");
    if (live >= 0) {
      const body = $("q-body");
      followLive =
        rowTop(live) + ROW_H > body.scrollTop && rowTop(live) < body.scrollTop + body.clientHeight;
    }
    throttledDraw();
  },
  { passive: true },
);
new ResizeObserver(throttledDraw).observe($("q-body"));

initServiceWorker();

// Uncomment to see why a browser is unsupported.
// console.log({
//   secure: isSecureContext,
//   usb: !!navigator.usb,
//   folders: !!window.showDirectoryPicker,
//   platform: navigator.userAgentData?.platform,
// });

// Only Chromium on macOS or Linux runs the app: it needs WebUSB and folder
// access (Brave turns the latter off), and on Windows the OS driver owns the
// phone. userAgentData exists only in Chromium, so Safari, Firefox and every
// iOS browser fail too.
const supported =
  navigator.usb &&
  window.showDirectoryPicker &&
  ["macOS", "Linux"].includes(navigator.userAgentData?.platform);
if (!supported) {
  $("unsupported").textContent = "This browser is not supported.\nUse Chrome on a Mac.";
  $("unsupported").hidden = false;
  $("steps").hidden = true;
  $("pick").hidden = true;
  $("help").hidden = true;
} else {
  initPwaInstall();
  // getDevices() returns devices this origin was already granted [WebUSB], so
  // a phone from a previous visit reconnects without a prompt.
  navigator.usb.getDevices().then((ds) => {
    const phone = ds.find((d) => offersMtp(d));
    if (phone) attach(phone);
  });
  navigator.usb.addEventListener("disconnect", (e) => {
    if (mtp && e.device === mtp.dev) disconnect();
  });
  // A replug or a USB-mode switch re-enumerates the device, so the grant from
  // the last visit lets the app take it back on its own.
  navigator.usb.addEventListener("connect", (e) => {
    if (offersMtp(e.device)) attach(e.device);
  });
  // Release the interface when the page goes away, or a reload leaves the
  // device claimed and the next load cannot take it.
  addEventListener("pagehide", () => {
    if (mtp) mtp.release();
  });
}
