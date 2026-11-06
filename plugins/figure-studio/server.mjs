#!/usr/bin/env node
/**
 * figure-studio MCP server。
 *
 * 职责：把 Python 内核（记录 / 覆盖 / 回写 matplotlib 样式）包成 MCP 工具，
 * 并把渲染结果以资源形式交给侧栏面板。
 *
 * 设计约束：
 *   · 工具结果有 64 KiB 上限，图片一律走 ui:// 资源，不塞进 structuredContent
 *   · Python 侧是常驻进程（冷启动 0.86 s，每次新建无法接受）
 *   · 预览渲染强制低 dpi，定稿才用脚本自己的 dpi
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 打包后本文件在 dist/ 下；插件根是它的父目录
const BUNDLE_DIR = __dirname;
const PLUGIN_ROOT = process.env.ZCODE_PLUGIN_ROOT || path.dirname(BUNDLE_DIR);
const WORKSPACE = path.resolve(process.env.ZCODE_WORKSPACE_ROOT || process.cwd());
const KERNEL_DIR = path.join(PLUGIN_ROOT, "kernel");
const WORKER_PY = path.join(KERNEL_DIR, "run_worker.py");
const PREVIEW_DIR = path.join(PLUGIN_ROOT, ".preview");
const PANEL_HTML = path.join(BUNDLE_DIR, "panel.html");
const PYTHON = process.env.FIGSTUDIO_PYTHON || "python";

const SURFACE_ID = "studio";
const PANEL_URI = "ui://figure-studio/panel.html";
const PREVIEW_PREFIX = "ui://figure-studio/preview/";
const HTML_MIME = "text/html;profile=mcp-app";

// ── 路径校验（只允许工作区内）────────────────────────────────
function resolveScript(input) {
  if (!input || input.includes("\0")) throw new Error("路径为空或不合法");
  const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(WORKSPACE, input);
  const rel = path.relative(WORKSPACE, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`只允许读取工作区内的文件：${input}`);
  }
  return abs;
}

// ── Python 常驻进程 ─────────────────────────────────────────
let worker = null;
let nextId = 1;
const pending = new Map();

function ensureWorker() {
  if (worker && !worker.killed) return worker;
  worker = spawn(PYTHON, ["-u", WORKER_PY], {
    cwd: KERNEL_DIR,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      // 内核据此校验输出目录只能落在预览目录内
      FIGSTUDIO_PREVIEW_ROOT: PREVIEW_DIR,
    },
    windowsHide: true,
  });

  const rl = readline.createInterface({ input: worker.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(`[${msg.error?.code}] ${msg.error?.message}`));
  });

  worker.stderr.on("data", (d) => process.stderr.write(`[kernel] ${d}`));
  worker.on("exit", (code) => {
    for (const [, entry] of pending) entry.reject(new Error(`渲染进程退出（code ${code}）`));
    pending.clear();
    worker = null;
  });

  return worker;
}

function callKernel(req, timeoutMs = 120000) {
  const proc = ensureWorker();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`渲染超时（${timeoutMs} ms）`));
      // 进程可能卡在用户脚本里，杀掉让它重启
      try { proc.kill(); } catch {}
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    proc.stdin.write(JSON.stringify({ id, ...req }) + "\n");
  });
}

// ── 预览图缓存（资源用，不进工具结果）────────────────────────
const previewCache = new Map(); // token -> { file, mime }

async function cachePreview(file) {
  const token = Math.random().toString(36).slice(2, 12);
  previewCache.set(token, {
    file,
    mime: file.toLowerCase().endsWith(".pdf") ? "application/pdf" : "image/png",
  });
  if (previewCache.size > 12) previewCache.delete(previewCache.keys().next().value);
  return token;
}

function ok(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: { ok: true, data },
  };
}

function fail(code, message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ code, message }) }],
    structuredContent: { ok: false, error: { code, message } },
    isError: true,
  };
}

// ── 服务 ───────────────────────────────────────────────────
const server = new McpServer(
  { name: "figure-studio", version: "0.1.1" },
  { capabilities: { tools: { listChanged: false }, resources: { listChanged: false } } },
);

const appOnly = { visibility: ["app"] };
const modelAndApp = { visibility: ["model", "app"] };
const panelInline = { resourceUri: PANEL_URI };
const panelSidebar = { resourceUri: PANEL_URI, surface: SURFACE_ID };

server.registerTool(
  "show_figure_studio",
  {
    title: "打开绘图调参面板",
    description: "在对话中打开面板：读取一个 Python 绘图脚本的样式参数，调完可写回源码。",
    inputSchema: { script: z.string().optional().describe("工作区内的 .py 路径，可留空后手动选择") },
    annotations: { readOnlyHint: true },
    _meta: { ui: { ...panelInline, ...modelAndApp } },
  },
  async ({ script }) => ok({ surface: SURFACE_ID, script: script || null, workspace: WORKSPACE }),
);

server.registerTool(
  "show_figure_studio_sidebar",
  {
    title: "在侧栏打开绘图调参面板",
    description: "把面板固定到会话侧栏，方便一边改参数一边看图。",
    inputSchema: { script: z.string().optional() },
    annotations: { readOnlyHint: true },
    _meta: { ui: { ...panelSidebar, ...modelAndApp } },
  },
  async ({ script }) => ok({ surface: SURFACE_ID, script: script || null, workspace: WORKSPACE }),
);

server.registerTool(
  "list_scripts",
  {
    title: "列出工作区里的绘图脚本",
    description: "扫描工作区内的 .py 文件，返回相对路径，供面板选择。",
    inputSchema: { limit: z.number().int().min(1).max(200).optional() },
  },
  async ({ limit = 80 }) => {
    const found = [];
    async function walk(dir, depth) {
      if (depth > 4 || found.length >= limit) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (found.length >= limit) return;
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "__pycache__") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.name.endsWith(".py")) found.push(path.relative(WORKSPACE, full));
      }
    }
    await walk(WORKSPACE, 0);
    return ok({ scripts: found, workspace: WORKSPACE });
  },
);

server.registerTool(
  "inspect_script",
  {
    title: "读取脚本的样式参数",
    description: "跑一遍脚本并记录它实际用到的全部样式参数（字号、配色、线宽、图幅、图例等）。",
    inputSchema: { script: z.string().describe("工作区内的 .py 路径") },
    annotations: { readOnlyHint: true },
    _meta: { ui: appOnly },
  },
  async ({ script }) => {
    try {
      const abs = resolveScript(script);
      const data = await callKernel({ cmd: "inspect", script: abs });
      return ok({ ...data, script: path.relative(WORKSPACE, abs) });
    } catch (e) {
      return fail("inspect_failed", String(e.message || e));
    }
  },
);

server.registerTool(
  "render_preview",
  {
    title: "按参数重画",
    description: "用给定覆盖值重画脚本，返回预览图资源 URI。不改源码、不覆盖原有成品图。",
    inputSchema: {
      script: z.string(),
      overrides: z.record(z.string(), z.any()).optional(),
      dpi: z.number().int().min(50).max(200).optional().describe("预览 dpi，默认 100"),
    },
    annotations: { readOnlyHint: true },
    _meta: { ui: appOnly },
  },
  async ({ script, overrides = {}, dpi = 100 }) => {
    try {
      const abs = resolveScript(script);
      const outDir = path.join(PREVIEW_DIR, path.basename(abs, ".py"));
      await fs.mkdir(outDir, { recursive: true });
      // 强制低 dpi 预览：定稿才用 600
      const ov = { "savefig.dpi": dpi, ...overrides };
      const data = await callKernel({ cmd: "render", script: abs, overrides: ov, out: outDir });
      const png = (data.outputs || []).find((f) => f.toLowerCase().endsWith(".png"));
      if (!png) return fail("no_output", "脚本没有产出 PNG；请确认它调用了 savefig");
      const token = await cachePreview(path.join(outDir, png));
      return ok({
        previewUri: PREVIEW_PREFIX + token,
        elapsed_ms: data.elapsed_ms,
        records: data.records,
        warnings: data.warnings || [],
        warning_summary: data.warning_summary || "",
        script_stdout: data.script_stdout,
      });
    } catch (e) {
      return fail("render_failed", String(e.message || e));
    }
  },
);

server.registerTool(
  "plan_rewrite",
  {
    title: "预览会怎么改源码",
    description: "生成写回的 diff 与被跳过的项，不落盘。确认后再 apply。",
    inputSchema: { script: z.string(), overrides: z.record(z.string(), z.any()) },
    annotations: { readOnlyHint: true },
    _meta: { ui: appOnly },
  },
  async ({ script, overrides }) => {
    try {
      const abs = resolveScript(script);
      return ok(await callKernel({ cmd: "plan", script: abs, overrides }));
    } catch (e) {
      return fail("plan_failed", String(e.message || e));
    }
  },
);

server.registerTool(
  "apply_rewrite",
  {
    title: "把参数写回源码",
    description: "按覆盖值修改脚本。默认只算不写；write=true 才落盘，并保留 .bak 备份。",
    inputSchema: {
      script: z.string(),
      overrides: z.record(z.string(), z.any()),
      write: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ script, overrides, write = false }) => {
    try {
      const abs = resolveScript(script);
      return ok(await callKernel({ cmd: "apply", script: abs, overrides, write }));
    } catch (e) {
      return fail("apply_failed", String(e.message || e));
    }
  },
);

// ── 资源 ───────────────────────────────────────────────────
server.registerResource(
  "panel",
  PANEL_URI,
  { mimeType: HTML_MIME, title: "Figure Studio" },
  async () => ({
    contents: [
      {
        uri: PANEL_URI,
        mimeType: HTML_MIME,
        text: await fs.readFile(PANEL_HTML, "utf8"),
      },
    ],
  }),
);

server.registerResource(
  "preview",
  new ResourceTemplate(`${PREVIEW_PREFIX}{token}`, { list: undefined }),
  {},
  async (uri) => {
    const token = uri.href.slice(PREVIEW_PREFIX.length);
    const hit = previewCache.get(token);
    if (!hit) throw new Error("预览已过期，请重新渲染");
    const bytes = await fs.readFile(hit.file);
    return {
      contents: [{ uri: uri.href, mimeType: hit.mime, blob: bytes.toString("base64") }],
    };
  },
);

await server.connect(new StdioServerTransport());
