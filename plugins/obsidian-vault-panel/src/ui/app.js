import { App } from "@modelcontextprotocol/ext-apps";
import { EditorView } from "@codemirror/view";
import { EditorState, Compartment, EditorSelection } from "@codemirror/state";
import {
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";
import { baseExtensions, previewExtension } from "./live-preview.js";
import { mountDrawing, unmountDrawing } from "./draw.js";

// ---------------------------------------------------------------- SVG Icons
const ICONS = {
  logo: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 9l3 13h12l3-13-9-7z" fill="url(#obs-grad)" stroke="#7c3aed" stroke-width="1.5"/><defs><linearGradient id="obs-grad" x1="3" y1="2" x2="21" y2="22" gradientUnits="userSpaceOnUse"><stop stop-color="#9333ea"/><stop offset="1" stop-color="#6366f1"/></linearGradient></defs></svg>`,
  sidebar: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></svg>`,
  newFile: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>`,
  newFolder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/><line x1="12" y1="10" x2="12" y2="16"/><line x1="9" y1="13" x2="15" y2="13"/></svg>`,
  search: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
  collapseAll: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5-5 5 5"/><path d="m7 9 5-5 5 5"/></svg>`,
  expandAll: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 9 5 5 5-5"/><path d="m7 15 5 5 5-5"/></svg>`,
  chevron: `<svg class="chev-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
  folder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
  file: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/><path d="M16 9H8"/></svg>`,
  plus: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`,
  trash: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`,
  save: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>`,
  docBig: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13H8"/><path d="M16 17H8"/><path d="M16 9H8"/></svg>`,
  refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
  draw: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19 7-7 3 3-7 7-3-3z"/><path d="m18 13-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="m2 2 7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>`,
};

// ---------------------------------------------------------------- bridge
// App.connect() throws if a transport is already attached, and close() does NOT
// clear it — so a failed handshake leaves that instance unusable. Build a fresh
// App for each retry instead.
function createApp() {
  const a = new App(
    { name: "obsidian-vault-panel", version: "0.7.0" },
    { availableDisplayModes: ["inline", "fullscreen"] }
  );
  a.onhostcontextchanged = applyHost;
  return a;
}

let app = createApp();
let hostReady = false;

function applyHost() {
  const ctx = app.getHostContext?.();
  try {
    applyHostStyleVariables?.(ctx?.styles);
    applyHostFonts?.(ctx?.styles);
    applyDocumentTheme?.(ctx?.theme ?? "light", ctx?.styles);
  } catch {
    document.documentElement.dataset.theme = ctx?.theme ?? "light";
  }
  // Excalidraw only reads its theme on mount, so re-mount when the host flips.
  const theme = ctx?.theme === "dark" ? "dark" : "light";
  if (state.theme !== theme) {
    state.theme = theme;
    if (state.drawing && state.live) {
      state.drawJson = getDoc() || state.drawJson;
      mountCanvas();
    }
  }
}

async function call(name, args) {
  if (!hostReady) throw new Error("面板尚未连接到宿主，请稍候重试");
  const res = await app.callServerTool({ name, arguments: args || {} });
  if (res?.isError) {
    const t = res.content?.find?.((c) => c.type === "text")?.text || "工具调用失败";
    throw new Error(t);
  }
  return res?.structuredContent ?? {};
}

// ---------------------------------------------------------------- DOM
const $ = (s) => document.querySelector(s);
const el = {
  vaultSel: $("#vaultSel"),
  search: $("#search"),
  searchBtn: $("#searchBtn"),
  collapseAllBtn: $("#collapseAllBtn"),
  expandAllBtn: $("#expandAllBtn"),
  tree: $("#tree"),
  editorHost: $("#editorHost"),
  drawHost: $("#drawHost"),
  tabLive: $("#tabLive"),
  tabSource: $("#tabSource"),
  saveBtn: $("#saveBtn"),
  delBtn: $("#delBtn"),
  newBtn: $("#newBtn"),
  newFolderBtn: $("#newFolderBtn"),
  newDrawBtn: $("#newDrawBtn"),
  status: $("#status"),
  statusText: $("#statusText"),
  statusStats: $("#statusStats"),
  title: $("#docTitle"),
  docIcon: $("#docIcon"),
  welcome: $("#welcome"),
  welcomeIcon: $("#welcomeIcon"),
  workspace: $("#workspace"),
  toast: $("#toast"),
  modeHint: $("#modeHint"),
  sidebar: $("#sidebar"),
  toggleSidebar: $("#toggleSidebar"),
  sidebarReopen: $("#sidebarReopen"),
  resizer: $("#resizer"),
  searchIcon: $("#searchIcon"),
  brandLogo: $("#brandLogo"),
  reloadBtn: $("#reloadBtn"),
  connBanner: $("#connBanner"),
  connBannerText: $("#connBannerText"),
  connBannerAction: $("#connBannerAction"),
  modalBackdrop: $("#modalBackdrop"),
  modalTitle: $("#modalTitle"),
  modalDesc: $("#modalDesc"),
  modalInput: $("#modalInput"),
  modalOk: $("#modalOk"),
  modalCancel: $("#modalCancel"),
};

// ---------------------------------------------------------------- In-panel Modals
function askText({ title, desc, value = "" }) {
  return new Promise((resolve) => {
    el.modalTitle.textContent = title;
    el.modalDesc.textContent = desc || "";
    el.modalDesc.hidden = !desc;
    el.modalInput.value = value;
    el.modalInput.hidden = false;
    el.modalOk.classList.remove("danger");
    el.modalBackdrop.hidden = false;
    const finish = (result) => {
      el.modalBackdrop.hidden = true;
      el.modalOk.removeEventListener("click", ok);
      el.modalCancel.removeEventListener("click", cancel);
      el.modalInput.removeEventListener("keydown", key);
      el.modalBackdrop.removeEventListener("mousedown", backdrop);
      resolve(result);
    };
    const ok = () => {
      const v = el.modalInput.value.trim();
      finish(v || null);
    };
    const cancel = () => finish(null);
    const key = (e) => {
      if (e.key === "Enter") { e.preventDefault(); ok(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    };
    const backdrop = (e) => { if (e.target === el.modalBackdrop) cancel(); };
    el.modalOk.addEventListener("click", ok);
    el.modalCancel.addEventListener("click", cancel);
    el.modalInput.addEventListener("keydown", key);
    el.modalBackdrop.addEventListener("mousedown", backdrop);
    setTimeout(() => { el.modalInput.focus(); el.modalInput.select(); }, 0);
  });
}

function askConfirm(message, isDanger = false) {
  return new Promise((resolve) => {
    el.modalTitle.textContent = isDanger ? "删除确认" : "请确认";
    el.modalDesc.textContent = message;
    el.modalDesc.hidden = false;
    el.modalInput.hidden = true;
    el.modalOk.classList.toggle("danger", isDanger);
    el.modalBackdrop.hidden = false;
    const finish = (result) => {
      el.modalBackdrop.hidden = true;
      el.modalOk.removeEventListener("click", ok);
      el.modalCancel.removeEventListener("click", cancel);
      el.modalBackdrop.removeEventListener("mousedown", backdrop);
      resolve(result);
    };
    const ok = () => finish(true);
    const cancel = () => finish(false);
    const backdrop = (e) => { if (e.target === el.modalBackdrop) cancel(); };
    el.modalOk.addEventListener("click", ok);
    el.modalCancel.addEventListener("click", cancel);
    el.modalBackdrop.addEventListener("mousedown", backdrop);
    setTimeout(() => el.modalOk.focus(), 0);
  });
}

function showBanner(text, kind = "warn", actionLabel = "", action = null) {
  el.connBannerText.textContent = text;
  el.connBanner.dataset.kind = kind;
  el.connBanner.hidden = false;
  if (actionLabel && action) {
    el.connBannerAction.textContent = actionLabel;
    el.connBannerAction.hidden = false;
    el.connBannerAction.onclick = action;
  } else {
    el.connBannerAction.hidden = true;
    el.connBannerAction.onclick = null;
  }
}

function hideBanner() {
  el.connBanner.hidden = true;
}

// A full page reload is the only reliable way to recover a panel whose MCP
// handshake or script state went bad after a plugin upgrade. It re-runs boot(),
// re-connects to the host and re-reads the vault.
async function reloadPanel() {
  if (state.dirty) {
    const ok = await askConfirm("当前笔记有未保存的修改，重新加载会丢失这些修改。确定继续吗？", true);
    if (!ok) return;
  }
  try {
    window.location.reload();
  } catch {
    location.href = location.href;
  }
}

// ---------------------------------------------------------------- sidebar sizing
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 520;
function applySidebarWidth(px) {
  const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, px));
  document.documentElement.style.setProperty("--sidebar-w", w + "px");
  try { localStorage.setItem("ovp.sidebarWidth", String(w)); } catch {}
}
function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  el.toggleSidebar.title = collapsed ? "展开文件树" : "收起文件树（也可拖动侧栏右边缘调宽）";
  try { localStorage.setItem("ovp.sidebarCollapsed", collapsed ? "1" : "0"); } catch {}
}
function initSidebar() {
  try {
    const w = Number(localStorage.getItem("ovp.sidebarWidth"));
    if (w >= SIDEBAR_MIN) applySidebarWidth(w);
    if (localStorage.getItem("ovp.sidebarCollapsed") === "1") setSidebarCollapsed(true);
  } catch {}
  el.toggleSidebar.addEventListener("click", () => {
    setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
  });
  el.sidebarReopen.addEventListener("click", () => setSidebarCollapsed(false));

  let startX = 0, startW = 0, dragging = false;
  el.resizer.addEventListener("pointerdown", (e) => {
    dragging = true;
    startX = e.clientX;
    startW = el.sidebar.getBoundingClientRect().width;
    el.resizer.classList.add("dragging");
    el.resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.resizer.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    applySidebarWidth(startW + (e.clientX - startX));
  });
  const endDrag = () => { dragging = false; el.resizer.classList.remove("dragging"); };
  el.resizer.addEventListener("pointerup", endDrag);
  el.resizer.addEventListener("pointercancel", endDrag);
}

const state = {
  vaults: [],
  vaultId: null,
  tree: null,
  openPath: null,
  openMtime: null,
  dirty: false,
  live: true,
  theme: "light",
  // Drawing state (.excalidraw canvas mode)
  drawing: false,
  drawJson: null,
};

function setStatus(msg, kind = "info") {
  el.status.dataset.kind = kind;
  el.statusText.textContent = msg;
}

function updateDocStats() {
  if (!view || !state.openPath) {
    el.statusStats.textContent = "";
    return;
  }
  const text = view.state.doc.toString();
  const chars = text.length;
  const lines = view.state.doc.lines;
  el.statusStats.textContent = `${chars.toLocaleString()} 字符 · ${lines} 行`;
}

let toastTimer;
function toast(msg, kind = "info") {
  el.toast.textContent = msg;
  el.toast.dataset.kind = kind;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2800);
}

function markDirty(d) {
  state.dirty = d;
  el.saveBtn.classList.toggle("dirty", d);
  renderSaveBtn(d);
  if (d) setStatus("有未保存的修改", "warn");
}

function renderSaveBtn(dirty) {
  el.saveBtn.innerHTML = `${ICONS.save}<span>${dirty ? "保存 •" : "已保存"}</span>`;
}

// ---------------------------------------------------------------- CodeMirror editor
const liveComp = new Compartment();
let view = null;

function createEditor() {
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged) {
      markDirty(true);
      updateDocStats();
    }
  });
  const saveKeymap = EditorView.domEventHandlers({
    keydown(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return true;
      }
      return false;
    },
  });

  view = new EditorView({
    parent: el.editorHost,
    state: EditorState.create({
      doc: "",
      extensions: [
        ...baseExtensions(),
        liveComp.of(state.live ? previewExtension() : []),
        updateListener,
        saveKeymap,
      ],
    }),
  });
}

function getDoc() {
  return view ? view.state.doc.toString() : "";
}

function setDoc(text) {
  if (!view) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: EditorSelection.cursor(0),
  });
  updateDocStats();
}

function setLive(on) {
  state.live = on;
  el.tabLive.classList.toggle("active", on);
  el.tabSource.classList.toggle("active", !on);
  if (state.drawing) {
    // Tab 1 = Excalidraw canvas, tab 2 = raw scene JSON.
    el.tabLive.textContent = "画布";
    if (on) showDrawingCanvas();
    else showDrawingSource();
    return;
  }
  el.modeHint.textContent = on ? "实时预览 · 光标行露源码" : "源码模式";
  el.editorHost.classList.toggle("source-mode", !on);
  if (view) {
    view.dispatch({ effects: liveComp.reconfigure(on ? previewExtension() : []) });
  }
}

// ---------------------------------------------------------------- tree
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Obsidian Excalidraw stores drawings as "*.excalidraw.md" (JSON in a code
// fence). Show them with a distinct icon so they aren't mistaken for prose.
function isExcalidrawFile(name) {
  return /\.excalidraw\.md$/i.test(name || "");
}

function buildTree(node, container, depth) {
  node.children.forEach((child) => {
    if (child.type === "dir") {
      const det = document.createElement("details");
      det.className = "folder";
      det.dataset.path = child.path;
      // DEFAULT COLLAPSED: 文件夹默认全部收起，清爽整洁！
      det.open = false;
      const sum = document.createElement("summary");
      sum.innerHTML = `
        <span class="chev">${ICONS.chevron}</span>
        <span class="ficon">${ICONS.folder}</span>
        <span class="fname folder-name">${escapeHtml(child.name)}</span>
        <span class="folder-actions">
          <button class="mini-btn" title="在此文件夹新建笔记" data-act="add-note">${ICONS.plus}</button>
          <button class="mini-btn" title="在此文件夹新建子文件夹" data-act="add-folder">${ICONS.newFolder}</button>
        </span>
      `;
      sum.querySelector('[data-act="add-note"]').addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation(); newNote(child.path);
      });
      sum.querySelector('[data-act="add-folder"]').addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation(); newFolder(child.path);
      });
      sum.addEventListener("contextmenu", (e) => showFolderMenu(e, child.path, child.name));
      det.appendChild(sum);
      const kids = document.createElement("div");
      kids.className = "kids";
      buildTree(child, kids, depth + 1);
      det.appendChild(kids);
      container.appendChild(det);
    } else {
      const a = document.createElement("button");
      a.className = "file" + (child.path === state.openPath ? " active" : "");
      a.dataset.path = child.path;
      const isCanvasFile = /\.excalidraw$/i.test(child.name);
      const isDrawingLike = child.kind === "drawing" || isExcalidrawFile(child.name);
      const fileIcon = isDrawingLike ? ICONS.draw : ICONS.file;
      const iconCls = isDrawingLike ? "ficon draw-icon" : "ficon file-icon";
      a.innerHTML = `
        <span class="${iconCls}">${fileIcon}</span>
        <span class="fname">${escapeHtml(child.name)}</span>
        <span class="file-actions">
          <button class="mini-btn del-btn" title="删除笔记" data-act="del-file">${ICONS.trash}</button>
        </span>
      `;
      a.querySelector('[data-act="del-file"]').addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation(); deleteNote(child.path);
      });
      a.addEventListener("click", () =>
        isCanvasFile ? openDrawing(child.path) : openNote(child.path)
      );
      a.addEventListener("contextmenu", (e) => showNoteMenu(e, child.path, child.name));
      container.appendChild(a);
    }
  });
}

function snapshotExpanded() {
  const open = new Set();
  el.tree.querySelectorAll("details.folder[open]").forEach((d) => open.add(d.dataset.path));
  return open;
}

function applyExpanded(openSet) {
  if (!openSet || !openSet.size) return;
  el.tree.querySelectorAll("details.folder").forEach((d) => {
    if (openSet.has(d.dataset.path)) d.open = true;
  });
}

function renderTree(tree, { preserve = true } = {}) {
  const prevOpen = preserve ? snapshotExpanded() : new Set();
  const prevScroll = el.tree.scrollTop;
  state.tree = tree;
  el.tree.innerHTML = "";
  if (!tree || !tree.children.length) {
    el.tree.innerHTML = '<div class="empty">这个库里还没有 Markdown 笔记</div>';
    return;
  }
  buildTree(tree, el.tree, 0);
  // Keep whatever the user had expanded, so an auto-sync doesn't visually reset
  // the whole tree back to collapsed.
  applyExpanded(prevOpen);
  if (state.openPath) {
    expandFolder(state.openPath);
    setActiveFile();
  }
  el.tree.scrollTop = prevScroll;
}

function setActiveFile() {
  el.tree.querySelectorAll(".file").forEach((b) => {
    b.classList.toggle("active", b.dataset.path === state.openPath);
  });
}

function collapseAll() {
  el.tree.querySelectorAll("details.folder").forEach((d) => (d.open = false));
}

function expandAll() {
  el.tree.querySelectorAll("details.folder").forEach((d) => (d.open = true));
}

// ---------------------------------------------------------------- actions
async function loadVaults() {
  const data = await call("list_vaults");
  state.vaults = data.vaults || [];
  el.vaultSel.innerHTML = "";
  state.vaults.forEach((v) => {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = v.name + (v.lastOpen ? "（上次打开）" : "");
    el.vaultSel.appendChild(o);
  });
  if (!state.vaults.length) {
    el.vaultSel.innerHTML = '<option value="">未发现 vault</option>';
    setStatus("未发现 Obsidian 库，请检查 obsidian.json", "warn");
    return;
  }
  state.vaultId =
    state.vaultId && state.vaults.some((v) => v.id === state.vaultId)
      ? state.vaultId
      : state.vaults[0].id;
  el.vaultSel.value = state.vaultId;
  await loadTree();
}

async function loadTree() {
  if (!state.vaultId) return;
  const data = await call("list_notes", { vault: state.vaultId });
  const v = data.vault;
  setStatus(`${v.name} · ${v.root}`, "info");
  renderTree(data.tree);
}

// ---------------------------------------------------------------- live sync
// The panel has no filesystem access of its own: folders created in Obsidian or
// Explorer are invisible until we re-read the tree. Poll a tiny revision counter
// and re-read only when it actually changed.
function treeHasFile(node, path) {
  if (!node) return false;
  if (node.type === "file") return node.path === path;
  return (node.children || []).some((c) => treeHasFile(c, path));
}

let lastRevision = null;
let syncTimer = null;
let syncing = false;

async function syncTree({ silent = true } = {}) {
  if (!state.vaultId || !hostReady || syncing) return;
  syncing = true;
  try {
    const data = await call("list_notes", { vault: state.vaultId });
    const openWas = state.openPath;
    renderTree(data.tree);
    if (openWas && !treeHasFile(data.tree, openWas)) {
      state.openPath = null;
      state.openMtime = null;
      markDirty(false);
      el.workspace.hidden = true;
      el.welcome.hidden = false;
      el.title.textContent = "";
      updateDocStats();
      toast("当前笔记已在外部被移除", "warn");
    }
    if (!silent) setStatus("目录已同步", "ok");
  } catch (e) {
    if (!silent) toast("同步失败：" + e.message, "bad");
  } finally {
    syncing = false;
  }
}

async function pollRevision() {
  if (!hostReady || !state.vaultId || syncing) return;
  if (document.hidden) return; // panel not visible: no point polling
  try {
    const data = await call("tree_revision", { vault: state.vaultId });
    if (lastRevision === null) {
      lastRevision = data.revision;
      return;
    }
    if (data.revision !== lastRevision) {
      lastRevision = data.revision;
      await syncTree();
    }
  } catch {
    /* transient; retry on next tick */
  }
}

function startSync(intervalMs = 2500) {
  stopSync();
  syncTimer = setInterval(pollRevision, intervalMs);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollRevision();
  });
  window.addEventListener("focus", () => pollRevision());
}

function stopSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

async function openNote(rel) {
  if (state.dirty && !(await askConfirm("当前笔记有未保存的修改，确定要放弃并打开另一篇吗？"))) return;
  try {
    leaveDrawing();
    setStatus("读取中…", "info");
    const data = await call("read_note", { vault: state.vaultId, path: rel });
    state.openPath = rel;
    state.openMtime = data.mtime;
    setDoc(data.content);
    el.title.textContent = rel;
    el.welcome.hidden = true;
    el.workspace.hidden = false;
    markDirty(false);
    expandFolder(rel);
    setActiveFile();
    if (isExcalidrawFile(rel)) {
      setStatus("Excalidraw 绘图文件 · 画布需在 Obsidian 中查看，这里显示其文本源码", "warn");
      toast("Excalidraw 绘图文件：画布请在 Obsidian 中打开", "info");
    } else {
      setStatus(`已打开 · ${(data.size / 1024).toFixed(1)} KB`, "ok");
    }
    if (view) view.focus();
  } catch (e) {
    setStatus("读取失败：" + e.message, "bad");
    toast(e.message, "bad");
  }
}

function leaveDrawing() {
  if (!state.drawing) return;
  unmountDrawing();
  state.drawing = false;
  state.drawJson = null;
  el.drawHost.hidden = true;
  el.drawHost.innerHTML = "";
  el.editorHost.hidden = false;
  el.tabLive.textContent = "实时预览";
}

// Open a plain .excalidraw scene in the embedded canvas.
async function openDrawing(rel) {
  if (state.dirty && !(await askConfirm("当前笔记有未保存的修改，确定要放弃并打开画布吗？"))) return;
  try {
    setStatus("读取画布…", "info");
    const data = await call("read_drawing", { vault: state.vaultId, path: rel });
    leaveDrawing();
    state.drawing = true;
    state.drawJson = data.content;
    state.openPath = rel;
    state.openMtime = data.mtime;
    state.live = true;
    el.tabLive.textContent = "画布";
    el.tabLive.classList.add("active");
    el.tabSource.classList.remove("active");
    el.modeHint.textContent = "Excalidraw 画布";
    el.title.textContent = rel;
    el.welcome.hidden = true;
    el.workspace.hidden = false;
    el.editorHost.hidden = true;
    el.drawHost.hidden = false;
    markDirty(false);
    mountCanvas();
    expandFolder(rel);
    setActiveFile();
    setStatus(`已打开画布 · ${(data.size / 1024).toFixed(1)} KB`, "ok");
    updateDocStats();
  } catch (e) {
    setStatus("打开画布失败：" + e.message, "bad");
    toast(e.message, "bad");
  }
}

function mountCanvas() {
  mountDrawing(el.drawHost, {
    jsonText: state.drawJson ?? "{}",
    theme: state.theme,
    onChange: (json) => {
      state.drawJson = json;
      markDirty(true);
      updateDocStats();
    },
  });
}

function showDrawingSource() {
  const json = state.drawJson ?? getDoc();
  if (state.drawJson == null) state.drawJson = json;
  unmountDrawing();
  setDoc(json);
  el.drawHost.hidden = true;
  el.editorHost.hidden = false;
  el.modeHint.textContent = "场景 JSON";
}

function showDrawingCanvas() {
  // Pick up edits made in source mode before remounting.
  state.drawJson = getDoc() || state.drawJson;
  el.editorHost.hidden = true;
  el.drawHost.hidden = false;
  mountCanvas();
  el.modeHint.textContent = "Excalidraw 画布";
}

async function newDrawing(folder = "") {
  const label = folder ? `在「${folder}」下` : "在库根目录";
  const name = await askText({
    title: `${label}新建画布`,
    desc: "会生成一个 .excalidraw 文件（Obsidian Excalidraw 插件可直接打开）",
    value: "新建画布.excalidraw",
  });
  if (!name) return;
  const rel = folder ? `${folder}/${name}` : name;
  try {
    const data = await call("create_drawing", { vault: state.vaultId, path: rel });
    await loadTree();
    expandFolder(rel);
    toast("已新建画布 " + data.path, "ok");
    await openDrawing(data.path);
  } catch (e) {
    toast(e.message, "bad");
  }
}

async function save() {
  if (!state.openPath) return;
  try {
    // In canvas mode the authoritative payload is the serialized scene, not the
    // CodeMirror buffer (which is hidden then). In source mode the buffer wins.
    const content = state.drawing && state.live
      ? (state.drawJson ?? getDoc())
      : getDoc();
    const tool = state.drawing ? "write_drawing" : "write_note";
    const data = await call(tool, {
      vault: state.vaultId,
      path: state.openPath,
      content,
      mtime: state.openMtime,
    });
    state.openMtime = data.mtime;
    if (state.drawing) state.drawJson = content;
    markDirty(false);
    setStatus("已保存到 vault · " + new Date().toLocaleTimeString(), "ok");
    toast("已保存到 vault", "ok");
  } catch (e) {
    setStatus("保存失败：" + e.message, "bad");
    toast(e.message, "bad");
  }
}

async function deleteNote(rel) {
  if (!rel) return;
  const noteName = rel.split("/").pop();
  const confirmed = await askConfirm(
    `确定要永久删除笔记「${noteName}」吗？\n文件将从磁盘中彻底移除，此操作无法撤销。`,
    true
  );
  if (!confirmed) return;
  try {
    await call("delete_note", { vault: state.vaultId, path: rel });
    toast(`已删除「${noteName}」`, "ok");
    if (state.openPath === rel) {
      state.openPath = null;
      state.openMtime = null;
      markDirty(false);
      el.workspace.hidden = true;
      el.welcome.hidden = false;
      el.title.textContent = "";
      updateDocStats();
    }
    await loadTree();
  } catch (e) {
    toast("删除失败：" + e.message, "bad");
  }
}

// folder: relative folder path, or "" for the vault root.
async function newNote(folder = "") {
  const label = folder ? `在「${folder}」下` : "在库根目录";
  const name = await askText({
    title: `${label}新建笔记`,
    desc: "名称不含 .md 时自动补；也可再写子目录，如 2026/文献/新笔记",
    value: "未命名笔记.md",
  });
  if (!name) return;
  const rel = folder ? `${folder}/${name}` : name;
  try {
    const data = await call("create_note", { vault: state.vaultId, path: rel, content: "" });
    await loadTree();
    expandFolder(rel);
    toast("已新建 " + data.path, "ok");
    await openNote(data.path);
  } catch (e) {
    toast(e.message, "bad");
  }
}

async function newFolder(parent = "") {
  const label = parent ? `在「${parent}」下` : "在库根目录";
  const name = await askText({
    title: `${label}新建文件夹`,
    desc: "名称可含多级，如 2026/文献",
    value: "新建文件夹",
  });
  if (!name) return;
  const rel = parent ? `${parent}/${name}` : name;
  try {
    const data = await call("create_folder", { vault: state.vaultId, path: rel });
    await loadTree();
    expandFolder(parent);
    expandFolder(rel);
    toast(data.existed ? "文件夹已存在" : "已新建文件夹 " + rel, "ok");
  } catch (e) {
    toast(e.message, "bad");
  }
}

function expandFolder(path) {
  if (!path) return;
  const parts = path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("/");
    const det = [...el.tree.querySelectorAll("details.folder")].find((n) => n.dataset.path === p);
    if (det) det.open = true;
  }
}

function closeCtxMenu() {
  document.querySelectorAll(".ctxmenu").forEach((m) => m.remove());
}

function showFolderMenu(e, folderPath, folderName) {
  e.preventDefault();
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctxmenu";
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 150) + "px";
  const item = (icon, text, fn, danger = false) => {
    const b = document.createElement("button");
    if (danger) b.className = "danger";
    b.innerHTML = `${icon}<span>${text}</span>`;
    b.addEventListener("click", () => { closeCtxMenu(); fn(); });
    return b;
  };
  menu.append(
    item(ICONS.plus, "在此新建笔记", () => newNote(folderPath)),
    item(ICONS.newFolder, "在此新建子文件夹", () => newFolder(folderPath)),
  );
  const sep = document.createElement("div"); sep.className = "sep"; menu.appendChild(sep);
  const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = folderName;
  menu.appendChild(hint);
  document.body.appendChild(menu);
  const dismiss = (ev) => { if (!menu.contains(ev.target)) { closeCtxMenu(); document.removeEventListener("mousedown", dismiss); } };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

function showNoteMenu(e, notePath, noteName) {
  e.preventDefault();
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctxmenu";
  menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - 150) + "px";
  const item = (icon, text, fn, danger = false) => {
    const b = document.createElement("button");
    if (danger) b.className = "danger";
    b.innerHTML = `${icon}<span>${text}</span>`;
    b.addEventListener("click", () => { closeCtxMenu(); fn(); });
    return b;
  };
  menu.append(
    item(ICONS.file, "打开笔记", () => openNote(notePath)),
    item(ICONS.trash, "删除笔记", () => deleteNote(notePath), true),
  );
  const sep = document.createElement("div"); sep.className = "sep"; menu.appendChild(sep);
  const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = noteName;
  menu.appendChild(hint);
  document.body.appendChild(menu);
  const dismiss = (ev) => { if (!menu.contains(ev.target)) { closeCtxMenu(); document.removeEventListener("mousedown", dismiss); } };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
}

async function search() {
  const q = el.search.value.trim();
  if (!q || !state.vaultId) return;
  try {
    setStatus("检索中…", "info");
    const data = await call("search_notes", { vault: state.vaultId, query: q, limit: 30 });
    const results = data.results || [];
    el.tree.innerHTML = "";
    if (!results.length) {
      el.tree.innerHTML = '<div class="empty">没有匹配的笔记</div>';
      setStatus(`“${q}” 无结果`, "info");
      return;
    }
    const head = document.createElement("div");
    head.className = "search-head";
    head.textContent = `搜索 “${q}” · ${results.length} 条`;
    el.tree.appendChild(head);
    results.forEach((r) => {
      const a = document.createElement("button");
      a.className = "file search-hit";
      const hitCanvas = /\.excalidraw$/i.test(r.name);
      const hitIcon = (hitCanvas || isExcalidrawFile(r.name)) ? ICONS.draw : ICONS.file;
      const hitCls = (hitCanvas || isExcalidrawFile(r.name)) ? "ficon draw-icon" : "ficon file-icon";
      a.innerHTML = `
        <span class="${hitCls}">${hitIcon}</span>
        <span class="fname">${escapeHtml(r.name)}<small>${escapeHtml(r.snippet)}</small></span>
        <span class="file-actions">
          <button class="mini-btn del-btn" title="删除笔记" data-act="del-file">${ICONS.trash}</button>
        </span>
      `;
      a.querySelector('[data-act="del-file"]').addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation(); deleteNote(r.path);
      });
      a.addEventListener("click", () => (hitCanvas ? openDrawing(r.path) : openNote(r.path)));
      el.tree.appendChild(a);
    });
    setStatus(`找到 ${results.length} 条`, "ok");
  } catch (e) {
    toast(e.message, "bad");
  }
}

// ---------------------------------------------------------------- Setup UI icons
function setupIcons() {
  el.brandLogo.innerHTML = ICONS.logo;
  el.toggleSidebar.innerHTML = ICONS.sidebar;
  el.newBtn.innerHTML = `${ICONS.newFile}<span>笔记</span>`;
  el.newFolderBtn.innerHTML = `${ICONS.newFolder}<span>文件夹</span>`;
  el.newDrawBtn.innerHTML = `${ICONS.draw}<span>画布</span>`;
  el.searchIcon.innerHTML = ICONS.search;
  el.searchBtn.innerHTML = ICONS.search;
  el.collapseAllBtn.innerHTML = ICONS.collapseAll;
  el.expandAllBtn.innerHTML = ICONS.expandAll;
  el.welcomeIcon.innerHTML = ICONS.docBig;
  el.docIcon.innerHTML = ICONS.file;
  el.delBtn.innerHTML = ICONS.trash;
  el.reloadBtn.innerHTML = ICONS.refresh;
  renderSaveBtn(false);
}

// ---------------------------------------------------------------- events
el.vaultSel.addEventListener("change", async () => {
  if (state.dirty && !(await askConfirm("当前笔记有未保存的修改，确定要切换库吗？"))) {
    el.vaultSel.value = state.vaultId;
    return;
  }
  state.vaultId = el.vaultSel.value;
  state.openPath = null;
  lastRevision = null;
  el.welcome.hidden = false;
  el.workspace.hidden = true;
  markDirty(false);
  updateDocStats();
  try {
    await loadTree();
    await pollRevision();
  } catch (e) {
    toast(e.message, "bad");
  }
});
el.search.addEventListener("keydown", (e) => {
  if (e.key === "Enter") search();
});
el.searchBtn.addEventListener("click", search);
el.collapseAllBtn.addEventListener("click", collapseAll);
el.expandAllBtn.addEventListener("click", expandAll);
el.newBtn.addEventListener("click", () => newNote(""));
el.newFolderBtn.addEventListener("click", () => newFolder(""));
el.newDrawBtn.addEventListener("click", () => newDrawing(""));
el.saveBtn.addEventListener("click", save);
el.reloadBtn.addEventListener("click", reloadPanel);
el.delBtn.addEventListener("click", () => deleteNote(state.openPath));
el.tabLive.addEventListener("click", () => setLive(true));
el.tabSource.addEventListener("click", () => setLive(false));
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    save();
  }
});
window.addEventListener("beforeunload", (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------------------------------------------------------------- boot
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connectWithRetry(maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // The SDK default request timeout is 60s; without an explicit timeout a
      // dead host would leave the panel blank for minutes before failing.
      await app.connect(undefined, { timeout: 6000 });
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[ovp] app.connect() attempt ${attempt}/${maxAttempts} failed:`, e);
      if (attempt === maxAttempts) break;
      setStatus(`正在重新连接宿主（${attempt}/${maxAttempts}）…`, "warn");
      showBanner(`面板与宿主的连接中断，正在自动重连（${attempt}/${maxAttempts}）…`, "warn");
      // A failed connect leaves the current App unusable (transport stays set).
      app = createApp();
      await sleep(400 * 2 ** (attempt - 1));
    }
  }
  throw lastErr || new Error("无法连接宿主");
}

async function boot() {
  setupIcons();
  createEditor();
  setLive(true);
  initSidebar();
  try {
    await connectWithRetry();
    hostReady = true;
    applyHost();

    // A panel can render while the session still holds the previous plugin
    // registration (ZCode does not hot-reload plugins into running tasks).
    // Surface id is the cheapest way to tell "current version" from "stale".
    const surface = app.getHostCapabilities?.()?.experimental?.["zcode/surface"];
    if (!surface || surface.id !== "obsidian-vault") {
      showBanner(
        "当前会话可能仍在使用旧版本插件（面板未按新版本注册）。建议按 Ctrl+N 新建会话；也可先点「刷新」重试。",
        "warn",
        "刷新",
        reloadPanel
      );
    } else {
      hideBanner();
    }

    await loadVaults();
    startSync();
  } catch (e) {
    setStatus("连接宿主失败：" + e.message, "bad");
    showBanner(
      "无法连接 ZCode 宿主，面板可能无法正常工作。点「刷新」重试；若仍失败，请新建会话（Ctrl+N）后重新打开面板。",
      "bad",
      "刷新",
      reloadPanel
    );
    console.error(e);
  }
}
boot();
