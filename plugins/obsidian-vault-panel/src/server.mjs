// ZCode UI Plugin server: browse / read / write Markdown notes in local Obsidian vaults.
// All filesystem access happens here (the panel itself is sandboxed).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import fssync from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const OBSIDIAN_CONFIG =
  process.env.OBSIDIAN_VAULT_CONFIG ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json");

// When installed as a plugin, dist/server.mjs sits in <root>/dist/ and ui/panel.html
// in <root>/dist/ui/. Resolve relative to this file so it works in dev and in the
// installed cache dir alike.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_PATH = path.join(HERE, "ui", "panel.html");
const PANEL_URI = "ui://obsidian-vault-panel/panel.html";
const SURFACE_ID = "obsidian-vault";
const HTML_MIME = "text/html;profile=mcp-app";

// ---------------------------------------------------------------- vault discovery
function vaultName(p) {
  return path.basename(p) || p;
}

async function loadVaults() {
  let cfg;
  try {
    cfg = JSON.parse(await fs.readFile(OBSIDIAN_CONFIG, "utf8"));
  } catch {
    return [];
  }
  const raw = cfg?.vaults || {};
  const out = [];
  for (const [id, v] of Object.entries(raw)) {
    if (!v || typeof v.path !== "string") continue;
    let root = v.path;
    try {
      await fs.access(root);
    } catch {
      continue;
    }
    // obsidian.json stores Windows paths; on win32 path.win32 is a no-op.
    root = path.resolve(root);
    out.push({ id, name: vaultName(root), root, lastOpen: !!v.open });
  }
  out.sort((a, b) => (b.lastOpen ? 1 : 0) - (a.lastOpen ? 1 : 0) || a.name.localeCompare(b.name));
  return out;
}

// A vault id is the public handle. Resolve to an absolute root, never trust a raw path.
async function resolveVault(vaultId) {
  const vaults = await loadVaults();
  const v = vaults.find((x) => x.id === vaultId) || vaults.find((x) => x.name === vaultId) || vaults[0];
  if (!v) throw new Error("没有找到可用的 Obsidian 库（检查 obsidian.json 或 OBSIDIAN_VAULT_CONFIG）");
  return v;
}

// Resolve a vault-relative path and guarantee it stays inside the vault root.
function safePath(root, rel) {
  const clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(root, clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error("路径越出 vault 根目录，已拒绝");
  }
  return abs;
}

const IGNORE = new Set([".obsidian", ".git", ".trash", "node_modules", ".DS_Store"]);

// Note-like files we surface in the tree:
//   .md            -> Markdown note
//   .excalidraw.md -> Obsidian Excalidraw drawing (Obsidian's own format)
//   .excalidraw    -> plain Excalidraw scene JSON
function fileKind(name) {
  const n = name.toLowerCase();
  if (n.endsWith(".excalidraw.md") || n.endsWith(".excalidraw")) return "drawing";
  if (n.endsWith(".md")) return "note";
  return null;
}

// ---------------------------------------------------------------- change tracking
// fs.watch(recursive) gives a cheap monotonic counter per vault. The panel polls
// tree_revision (a few bytes) instead of re-walking the whole tree every tick.
const watchers = new Map();

function watcherFor(v) {
  const existing = watchers.get(v.id);
  if (existing) return existing;
  const entry = { rev: 1, watcher: null, timer: null };
  try {
    entry.watcher = fssync.watch(v.root, { recursive: true }, () => {
      // Debounce bursts: Obsidian touches .obsidian/* and temp files a lot.
      if (entry.timer) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.rev++;
      }, 300);
      entry.timer.unref?.();
    });
    // A watch error must not crash the stdio server.
    entry.watcher.on?.("error", () => {});
    entry.watcher.unref?.();
  } catch {
    entry.watcher = null;
  }
  watchers.set(v.id, entry);
  return entry;
}

async function walkTree(root, rel, depth, maxDepth, maxEntries) {
  const node = { name: path.basename(rel) || "", path: rel, type: "dir", children: [] };
  if (depth > maxDepth) return node;
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return node;
  }
  let count = 0;
  for (const e of entries) {
    if (count++ >= maxEntries) break;
    if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      node.children.push(await walkTree(root, childRel, depth + 1, maxDepth, maxEntries));
    } else {
      const kind = fileKind(e.name);
      if (kind) node.children.push({ name: e.name, path: childRel, type: "file", kind });
    }
  }
  node.children.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
  );
  return node;
}

function text(msg) {
  return { content: [{ type: "text", text: msg }] };
}

// ---------------------------------------------------------------- MCP server
const server = new McpServer({ name: "obsidian-vault-panel", version: "0.1.0" });

// The HTML resource. Single-file, all CSS/JS inlined (sandbox CSP blocks external refs).
server.registerResource(
  "panel",
  PANEL_URI,
  { mimeType: HTML_MIME },
  async () => ({
    contents: [
      {
        uri: PANEL_URI,
        mimeType: HTML_MIME,
        text: await fs.readFile(PANEL_PATH, "utf8"),
      },
    ],
  })
);

// Tool metadata: panel-capable tools wake/attach the session sidebar surface.
// "app-only" tools are only reachable from the panel, never from the model directly.
function meta(appOnly) {
  return {
    ui: {
      resourceUri: PANEL_URI,
      surface: SURFACE_ID,
      visibility: appOnly ? ["app"] : ["model", "app"],
    },
    "openai/ui": { preferredModelDisplayMode: "fullscreen" },
  };
}

function tool(name, cfg, appOnly, handler) {
  server.registerTool(
    name,
    {
      description: cfg.description,
      inputSchema: cfg.inputSchema,
      annotations: { readOnlyHint: cfg.readOnly ?? true },
      _meta: meta(appOnly),
    },
    handler
  );
}

// ---- panel-only tools ------------------------------------------------------------
tool(
  "list_vaults",
  {
    description: "列出本机 Obsidian 已登记的所有 vault（库）",
    inputSchema: {},
  },
  true,
  async () => {
    const vaults = await loadVaults();
    return { structuredContent: { vaults } };
  }
);

tool(
  "list_notes",
  {
    description: "列出某个 vault 里的 Markdown 笔记目录树",
    inputSchema: { vault: z.string().optional().describe("vault id 或名称") },
  },
  true,
  async ({ vault }) => {
    const v = await resolveVault(vault);
    const tree = await walkTree(v.root, "", 0, 6, 400);
    return { structuredContent: { vault: { id: v.id, name: v.name, root: v.root }, tree } };
  }
);

tool(
  "tree_revision",
  {
    description: "返回某个 vault 目录树的变更版本号；版本号变化表示文件夹/笔记在外部被改动",
    inputSchema: { vault: z.string().optional().describe("vault id 或名称") },
  },
  true,
  async ({ vault }) => {
    const v = await resolveVault(vault);
    const w = watcherFor(v);
    return {
      structuredContent: {
        revision: w.rev,
        watching: !!w.watcher,
        vault: { id: v.id, name: v.name },
      },
    };
  }
);

tool(
  "read_note",
  {
    description: "读取 vault 里一篇 Markdown 笔记的正文与修改时间",
    inputSchema: {
      vault: z.string().describe("vault id"),
      path: z.string().describe("相对 vault 根的路径，如 folder/note.md"),
    },
  },
  true,
  async ({ vault, path: rel }) => {
    const v = await resolveVault(vault);
    const abs = safePath(v.root, rel);
    const st = await fs.stat(abs);
    const content = await fs.readFile(abs, "utf8");
    return {
      structuredContent: {
        path: rel,
        content,
        mtime: st.mtimeMs,
        size: st.size,
        vault: { id: v.id, name: v.name },
      },
    };
  }
);

tool(
  "write_note",
  {
    description: "把内容写回 vault 里的 Markdown 笔记；带 mtime 乐观锁，若笔记已被外部改动则拒绝覆盖",
    inputSchema: {
      vault: z.string().describe("vault id"),
      path: z.string().describe("相对 vault 根的路径"),
      content: z.string().describe("完整的新正文"),
      mtime: z.number().optional().describe("读取时的 mtimeMs；不一致则拒绝覆盖"),
    },
  },
  true,
  async ({ vault, path: rel, content, mtime }) => {
    const v = await resolveVault(vault);
    const abs = safePath(v.root, rel);
    if (!abs.toLowerCase().endsWith(".md")) throw new Error("只能写入 .md 文件");
    let currentMtime = 0;
    try {
      currentMtime = (await fs.stat(abs)).mtimeMs;
    } catch {
      /* new file */
    }
    if (mtime != null && currentMtime && Math.abs(currentMtime - mtime) > 2) {
      throw new Error("文件在 Obsidian 端被改动过，已拒绝覆盖（请重新读取再保存）");
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    const st = await fs.stat(abs);
    return { structuredContent: { path: rel, mtime: st.mtimeMs, saved: true } };
  }
);

tool(
  "create_note",
  {
    description: "在 vault 里新建一篇 Markdown 笔记",
    inputSchema: {
      vault: z.string().describe("vault id"),
      path: z.string().describe("相对路径，如 新建笔记.md；不含 .md 时自动补"),
      content: z.string().optional().describe("初始正文"),
    },
  },
  true,
  async ({ vault, path: rel, content }) => {
    const v = await resolveVault(vault);
    let clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean.toLowerCase().endsWith(".md")) clean += ".md";
    const abs = safePath(v.root, clean);
    if (fssync.existsSync(abs)) throw new Error("同名笔记已存在");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content ?? "", "utf8");
    const st = await fs.stat(abs);
    return { structuredContent: { path: clean, mtime: st.mtimeMs, saved: true } };
  }
);

const EMPTY_SCENE = JSON.stringify(
  { type: "excalidraw", version: 2, source: "zcode-obsidian-vault-panel", elements: [], appState: {}, files: {} },
  null,
  2
);

tool(
  "read_drawing",
  {
    description: "读取 vault 里一个 .excalidraw 画布的 JSON 与修改时间",
    inputSchema: {
      vault: z.string().describe("vault id"),
      path: z.string().describe("相对 vault 根的 .excalidraw 路径"),
    },
  },
  true,
  async ({ vault, path: rel }) => {
    const v = await resolveVault(vault);
    const abs = safePath(v.root, rel);
    if (!abs.toLowerCase().endsWith(".excalidraw")) throw new Error("只能读取 .excalidraw 画布");
    const st = await fs.stat(abs);
    const content = await fs.readFile(abs, "utf8");
    return { structuredContent: { path: rel, content, mtime: st.mtimeMs, size: st.size } };
  }
);

tool(
  "write_drawing",
  {
    description: "把 Excalidraw 场景 JSON 写回 vault；带 mtime 乐观锁",
    inputSchema: {
      vault: z.string().describe("vault id"),
      path: z.string().describe("相对 vault 根的 .excalidraw 路径"),
      content: z.string().describe("完整场景 JSON 文本"),
      mtime: z.number().optional().describe("读取时的 mtimeMs；不一致则拒绝覆盖"),
    },
  },
  true,
  async ({ vault, path: rel, content, mtime }) => {
    const v = await resolveVault(vault);
    const abs = safePath(v.root, rel);
    if (!abs.toLowerCase().endsWith(".excalidraw")) throw new Error("只能写入 .excalidraw 画布");
    let currentMtime = 0;
    try {
      currentMtime = (await fs.stat(abs)).mtimeMs;
    } catch {
      /* new */
    }
    if (mtime != null && currentMtime && Math.abs(currentMtime - mtime) > 2) {
      throw new Error("画布在外部被改动过，已拒绝覆盖（请重新打开再保存）");
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    const st = await fs.stat(abs);
    return { structuredContent: { path: rel, mtime: st.mtimeMs, saved: true } };
  }
);

tool(
  "create_drawing",
  {
    description: "在 vault 里新建一个空白 .excalidraw 画布",
    inputSchema: {
      vault: z.string().describe("vault id"),
      path: z.string().describe("相对路径；不含 .excalidraw 时自动补"),
    },
  },
  true,
  async ({ vault, path: rel }) => {
    const v = await resolveVault(vault);
    let clean = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (!clean.toLowerCase().endsWith(".excalidraw")) clean += ".excalidraw";
    const abs = safePath(v.root, clean);
    if (fssync.existsSync(abs)) throw new Error("同名画布已存在");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, EMPTY_SCENE, "utf8");
    const st = await fs.stat(abs);
    return { structuredContent: { path: clean, mtime: st.mtimeMs, created: true } };
  }
);

tool(
  "create_folder",
  {
    description: "在 vault 里新建一个文件夹（可含多级路径）",
    inputSchema: {
      vault: z.string().describe("vault id"),
      path: z.string().describe("相对 vault 根的文件夹路径，如 文献/2026"),
    },
  },
  true,
  async ({ vault, path: rel }) => {
    const v = await resolveVault(vault);
    const abs = safePath(v.root, rel);
    if (fssync.existsSync(abs)) {
      const st = await fs.stat(abs);
      if (!st.isDirectory()) throw new Error("同名文件已存在，无法建文件夹");
      return { structuredContent: { path: rel, existed: true } };
    }
    await fs.mkdir(abs, { recursive: true });
    return { structuredContent: { path: rel, created: true } };
  }
);

tool(
  "delete_note",
  {
    description: "在 vault 里删除指定的 Markdown 笔记",
    inputSchema: {
      vault: z.string().describe("vault id"),
      path: z.string().describe("相对 vault 根的笔记路径，如 folder/note.md"),
    },
  },
  true,
  async ({ vault, path: rel }) => {
    const v = await resolveVault(vault);
    const abs = safePath(v.root, rel);
    const lower = abs.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".excalidraw")) {
      throw new Error("只能删除 .md 或 .excalidraw 文件");
    }
    if (!fssync.existsSync(abs)) {
      throw new Error("笔记不存在，无法删除");
    }
    await fs.unlink(abs);
    return { structuredContent: { path: rel, deleted: true } };
  }
);

tool(
  "search_notes",
  {
    description: "在某个 vault 的 Markdown 笔记里做全文检索（大小写不敏感）",
    inputSchema: {
      vault: z.string().describe("vault id"),
      query: z.string().describe("检索词"),
      limit: z.number().optional().describe("最多返回条数，默认 30"),
    },
  },
  true,
  async ({ vault, query, limit }) => {
    const v = await resolveVault(vault);
    const q = String(query || "").toLowerCase();
    if (!q) return { structuredContent: { results: [] } };
    const max = Math.min(Number(limit) || 30, 100);
    const results = [];
    async function scan(rel, depth) {
      if (depth > 8 || results.length >= max) return;
      const dir = path.join(v.root, rel);
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (results.length >= max) break;
        if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await scan(childRel, depth + 1);
        } else if (e.name.toLowerCase().endsWith(".md")) {
          let body;
          try {
            body = await fs.readFile(path.join(v.root, childRel), "utf8");
          } catch {
            continue;
          }
          const idx = body.toLowerCase().indexOf(q);
          if (idx >= 0) {
            const start = Math.max(0, idx - 40);
            results.push({
              path: childRel,
              name: e.name,
              snippet: body.slice(start, idx + q.length + 60).replace(/\s+/g, " "),
            });
          }
        }
      }
    }
    await scan("", 0);
    return { structuredContent: { results } };
  }
);

// ---- model-callable: open the panel ---------------------------------------------
tool(
  "open_vault_panel",
  {
    description:
      "在 ZCode 会话侧栏打开 Obsidian 笔记面板，浏览/编辑本机 Obsidian vault 中的 Markdown 笔记。用户想看、写或在侧栏里操作 Obsidian 笔记时调用。",
    inputSchema: {},
  },
  false,
  async () => {
    const vaults = await loadVaults();
    return {
      ...text(
        vaults.length
          ? `已打开 Obsidian 笔记面板。本机发现 ${vaults.length} 个库：${vaults.map((v) => v.name).join("、")}。`
          : "已打开 Obsidian 笔记面板，但未发现可用 vault。"
      ),
      structuredContent: { vaults },
    };
  }
);

// ---------------------------------------------------------------- boot
const transport = new StdioServerTransport();
await server.connect(transport);
