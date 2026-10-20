import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocumentInfo, TextAnchor } from "../shared/types.js";
import {
  WorkspaceError,
  isSupportedDocument,
  kindOf,
  listDocuments,
  loadDocument,
  resolveExternalFile,
  resolveWorkspaceFile,
  sha256,
  toWorkspaceRelative,
  workspaceRoot,
} from "./workspace.js";
import { clearDrafts, loadDrafts, saveDrafts, storePath, workspaceKey } from "./store.js";
import { docxToMarkdown } from "./docx.js";
import { pickExternalDocument } from "./picker.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const distRoot = path.join(pluginRoot, "dist");

const SURFACE_ID = "reviewer";
const PANEL_URI = "ui://document-reviewer/panel.html";
const ASSET_PREFIX = "ui://document-reviewer/assets/";
const FILE_PREFIX = "ui://document-reviewer/file/";
const HTML_MIME = "text/html;profile=mcp-app";
const CHUNK_BYTES = 1024 * 1024;
const MAX_CACHED_DOCS = 4;
const MAX_CACHE_BYTES = 160 * 1024 * 1024;
const TEXT_CHUNK_CHARS = 200_000;

interface CachedDocument {
  info: DocumentInfo;
  bytes: Buffer;
  /** Decoded UTF-8 text for md/txt documents, split by characters for chunking. */
  text?: string;
  cachedAt: number;
}

const docCache = new Map<string, CachedDocument>();
let cachedBytes = 0;

/** Absolute paths the user explicitly opened from outside the workspace. */
const externalPaths = new Set<string>();

function normalizedAbsolute(input: string): string {
  return input.replace(/\\/g, "/").trim();
}

function isAbsoluteInput(input: string): boolean {
  return path.isAbsolute(normalizedAbsolute(input));
}

async function resolveDocumentPath(input: string): Promise<string> {
  try {
    return await resolveWorkspaceFile(input);
  } catch (error) {
    if (!(error instanceof WorkspaceError) || error.code !== "outside_workspace") {
      throw error;
    }
    if (!isAbsoluteInput(input)) throw error;
    const abs = await resolveExternalFile(input);
    const normalized = normalizedAbsolute(abs);
    if (!externalPaths.has(normalized)) {
      throw new WorkspaceError(
        "outside_workspace",
        "该外部文件尚未在面板中打开；请先在面板里通过「打开路径」打开它",
      );
    }
    return abs;
  }
}

function evictCache(): void {
  while (docCache.size > MAX_CACHED_DOCS || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = docCache.keys().next().value as string | undefined;
    if (!oldest) break;
    const entry = docCache.get(oldest);
    if (entry) cachedBytes -= entry.bytes.byteLength;
    docCache.delete(oldest);
  }
}

function errorPayload(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: `错误：${message}` }],
    structuredContent: { ok: false, error: { code, message } },
    isError: true,
  };
}

function okPayload<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: { ok: true, data } as unknown as Record<string, unknown>,
  };
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof WorkspaceError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: "internal_error", message: error.message };
  }
  return { code: "internal_error", message: String(error) };
}

async function loadDocumentForToken(
  input: string,
  options?: { external?: boolean },
) {
  if (options?.external) {
    return loadDocument(input, { external: true });
  }
  try {
    return await loadDocument(input);
  } catch (error) {
    if (
      error instanceof WorkspaceError &&
      error.code === "outside_workspace" &&
      isAbsoluteInput(input)
    ) {
      const abs = await resolveExternalFile(input);
      if (!externalPaths.has(normalizedAbsolute(abs))) {
        throw new WorkspaceError(
          "outside_workspace",
          "该外部文件尚未在面板中打开；请先在面板里通过「打开路径」打开它",
        );
      }
      return loadDocument(normalizedAbsolute(abs), { external: true });
    }
    throw error;
  }
}

async function openDocumentToken(
  input: string,
  options?: { external?: boolean },
): Promise<DocumentInfo> {
  const loaded = await loadDocumentForToken(input, options);
  if (loaded.info.external) {
    externalPaths.add(normalizedAbsolute(loaded.info.path));
  }
  const token = sha256(
    Buffer.from(`${loaded.info.path}:${loaded.info.hash}:${Date.now()}:${Math.random()}`),
  ).slice(0, 24);

  let text: string | undefined;
  let warnings = loaded.info.warnings ?? [];
  if (loaded.info.kind === "docx") {
    try {
      const converted = await docxToMarkdown(loaded.bytes);
      text = converted.markdown;
      if (!text.trim()) {
        throw new WorkspaceError("docx_empty", "DOCX 中没有可预览的文本");
      }
      warnings = [...warnings, ...converted.warnings].slice(0, 8);
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError(
        "docx_conversion_failed",
        `DOCX 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else if (!loaded.info.binary) {
    text = loaded.bytes.toString("utf8");
  }

  const isBinary = loaded.info.kind === "pdf";
  const chunkCount = isBinary
    ? Math.max(1, Math.ceil(loaded.bytes.byteLength / CHUNK_BYTES))
    : Math.max(1, Math.ceil((text?.length ?? 0) / TEXT_CHUNK_CHARS));
  const info: DocumentInfo = {
    ...loaded.info,
    token,
    chunkCount,
    chunkBytes: isBinary ? CHUNK_BYTES : TEXT_CHUNK_CHARS,
    ...(loaded.info.kind === "docx" ? { converted: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
  const previous = docCache.get(token);
  if (previous) cachedBytes -= previous.bytes.byteLength;
  docCache.set(token, { info, bytes: loaded.bytes, text, cachedAt: Date.now() });
  cachedBytes += loaded.bytes.byteLength;
  evictCache();
  return info;
}

async function findCachedByPath(docPath: string): Promise<CachedDocument | undefined> {
  for (const entry of docCache.values()) {
    if (entry.info.path === docPath) return entry;
  }
  return undefined;
}

function lineOf(offsets: number[], position: number): number {
  // 1-based line number for a character offset.
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

function makeTextAnchor(text: string, start: number, end: number): TextAnchor {
  const offsets = buildLineOffsets(text);
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  return {
    kind: "text",
    start: safeStart,
    end: safeEnd,
    startLine: lineOf(offsets, safeStart),
    endLine: lineOf(offsets, Math.max(safeStart, safeEnd - 1)),
    prefix: text.slice(Math.max(0, safeStart - 60), safeStart),
    suffix: text.slice(safeEnd, Math.min(text.length, safeEnd + 60)),
  };
}

const server = new McpServer(
  { name: "document-reviewer", version: "0.9.0" },
  {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
    },
  },
);

const appOnly = { visibility: ["app"] as ["app"] };
const modelAndApp = { visibility: ["model", "app"] as ["model", "app"] };
/** Inline rendering: the panel appears as a card in the conversation. */
const panelUiInline = {
  resourceUri: PANEL_URI,
};
/** Sidebar rendering: used only when the user explicitly wants the side panel. */
const panelUiSidebar = {
  resourceUri: PANEL_URI,
  surface: SURFACE_ID,
};

server.registerTool(
  "show_reviewer",
  {
    title: "打开文档批注面板",
    description:
      "在对话中内联打开 Document Reviewer 面板（无需单独打开插件页）。用户可以从工作区选择 Markdown、TXT、PDF 或 DOCX 文档，选中文字添加批注，然后把全部批注一次性发送给主 Agent。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { ...panelUiInline, ...modelAndApp } },
  },
  async () => {
    return okPayload({
      workspace: { root: workspaceRoot(), workspaceKey: workspaceKey() },
      surface: SURFACE_ID,
    });
  },
);

server.registerTool(
  "show_reviewer_sidebar",
  {
    title: "在侧栏打开文档批注面板",
    description:
      "在会话侧栏打开 Document Reviewer 面板。仅在用户明确要求使用侧栏/固定面板时调用；一般情况下用 show_reviewer 内联打开即可。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { ...panelUiSidebar, ...modelAndApp } },
  },
  async () => {
    return okPayload({
      workspace: { root: workspaceRoot(), workspaceKey: workspaceKey() },
      surface: SURFACE_ID,
    });
  },
);

server.registerTool(
  "open_document",
  {
    title: "在批注面板中打开文档",
    description:
      "在 Document Reviewer 面板中内联打开工作区内的一篇 Markdown、TXT、PDF 或 DOCX 文档，供用户阅读、选中文字并添加批注。DOCX 会转换为 Markdown 预览。",
    inputSchema: {
      path: z.string().describe("工作区相对路径，例如 docs/report.md"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { ...panelUiInline, ...modelAndApp } },
  },
  async ({ path: docPath }) => {
    try {
      const info = await openDocumentToken(docPath);
      return okPayload({ document: info });
    } catch (error) {
      const { code, message } = describeError(error);
      return errorPayload(code, message);
    }
  },
);

server.registerTool(
  "open_external_document",
  {
    title: "打开工作区外的文档",
    description:
      "由用户在面板中输入绝对路径后调用，打开工作区之外的 Markdown、TXT、PDF 或 DOCX。仅面板可调用；Agent 不能主动使用此工具读取任意路径。",
    inputSchema: {
      path: z.string().describe("文件的绝对路径，例如 D:/papers/report.docx"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async ({ path: docPath }) => {
    try {
      const info = await openDocumentToken(docPath, { external: true });
      return okPayload({ document: info });
    } catch (error) {
      const { code, message } = describeError(error);
      return errorPayload(code, message);
    }
  },
);

server.registerTool(
  "pick_external_document",
  {
    title: "选择工作区外的文件",
    description:
      "打开系统文件选择器，由用户选择一个工作区外的 Markdown、TXT、PDF 或 DOCX 文件并返回绝对路径。仅面板可调用；用户取消时返回 null。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async () => {
    try {
      const picked = await pickExternalDocument();
      return okPayload({ path: picked });
    } catch (error) {
      const { code, message } = describeError(error);
      return errorPayload(code, message);
    }
  },
);

server.registerTool(
  "list_documents",
  {
    title: "列出工作区文档",
    description:
      "列出当前工作区中可批注的文档（.md、.markdown、.txt、.pdf、.docx），可按子目录过滤并分页。",
    inputSchema: {
      subdir: z.string().optional().describe("限定搜索的子目录（工作区相对路径）"),
      offset: z.number().int().min(0).optional().describe("分页起始位置，默认 0"),
      limit: z.number().int().min(1).max(500).optional().describe("每页数量，默认 200"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ subdir, offset, limit }) => {
    try {
      const all = await listDocuments(subdir);
      const start = offset ?? 0;
      const take = limit ?? 200;
      const items = all.slice(start, start + take).map((rel) => ({
        path: rel,
        name: path.basename(rel),
        kind: kindOf(rel),
      }));
      return okPayload({
        root: workspaceRoot(),
        total: all.length,
        offset: start,
        hasMore: start + items.length < all.length,
        items,
      });
    } catch (error) {
      const { code, message } = describeError(error);
      return errorPayload(code, message);
    }
  },
);

server.registerTool(
  "read_document_text",
  {
    title: "读取文档文本",
    description:
      "读取 Markdown/TXT 文档的文本内容（按字符分片），返回 DOCX 的转换预览文本，或返回 PDF 的页数与元数据。用于核对批注所指向的原文。",
    inputSchema: {
      path: z.string().describe("工作区相对路径"),
      offset: z.number().int().min(0).optional().describe("字符偏移，默认 0"),
      limit: z.number().int().min(1).max(200000).optional().describe("最多返回的字符数"),
      refresh: z.boolean().optional().describe("重新读取文件并校验哈希"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ path: docPath, offset, limit, refresh }) => {
    try {
      const info = await openDocumentToken(docPath);
      const cached = docCache.get(info.token);
      if (!cached) return errorPayload("internal_error", "文档缓存失效");
      if (info.kind === "pdf") {
        return okPayload({
          document: {
            path: info.path,
            kind: info.kind,
            size: info.size,
            hash: info.hash,
            token: info.token,
            chunkCount: info.chunkCount,
          },
          note: "PDF 文本请使用 pdf 插件或 pdf.js 读取；这里只提供元数据与分片访问。",
        });
      }
      const text = cached.text ?? cached.bytes.toString("utf8");
      const start = Math.max(0, offset ?? 0);
      const take = Math.min(limit ?? TEXT_CHUNK_CHARS, TEXT_CHUNK_CHARS);
      const slice = text.slice(start, start + take);
      const refreshed = refresh ? sha256(cached.bytes) : info.hash;
      return okPayload({
        document: {
          path: info.path,
          kind: info.kind,
          size: info.size,
          hash: refreshed,
          totalChars: text.length,
          start,
          end: start + slice.length,
          hasMore: start + slice.length < text.length,
        },
        text: slice,
      });
    } catch (error) {
      const { code, message } = describeError(error);
      return errorPayload(code, message);
    }
  },
);

server.registerTool(
  "compute_text_anchor",
  {
    title: "把子串转换为字符锚点",
    description:
      "给定工作区文档路径、选中的原文以及可选的出现序号，计算字符偏移与行号锚点。找不到时返回 ambiguous 或 not_found，不要猜测位置。",
    inputSchema: {
      path: z.string(),
      quote: z.string().describe("选中的原文"),
      occurrence: z.number().int().min(0).optional().describe("第几次出现，从 0 开始"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ path: docPath, quote, occurrence }) => {
    try {
      const info = await openDocumentToken(docPath);
      if (info.kind === "pdf") return errorPayload("unsupported", "PDF 请使用页码锚点");
      const cached = docCache.get(info.token);
      if (!cached) return errorPayload("internal_error", "文档缓存失效");
      const text = cached.text ?? cached.bytes.toString("utf8");
      const positions: number[] = [];
      let from = 0;
      while (positions.length < 50) {
        const at = text.indexOf(quote, from);
        if (at < 0) break;
        positions.push(at);
        from = at + Math.max(1, quote.length);
      }
      if (positions.length === 0) {
        return okPayload({ found: false, reason: "not_found", count: 0 });
      }
      const index = occurrence ?? 0;
      if (index >= positions.length) {
        return okPayload({
          found: false,
          reason: "occurrence_out_of_range",
          count: positions.length,
        });
      }
      const start = positions[index];
      return okPayload({
        found: true,
        count: positions.length,
        ambiguous: positions.length > 1,
        anchor: makeTextAnchor(text, start, start + quote.length),
        document: { path: info.path, hash: info.hash },
      });
    } catch (error) {
      const { code, message } = describeError(error);
      return errorPayload(code, message);
    }
  },
);

server.registerTool(
  "check_documents",
  {
    title: "校验文档是否变化",
    description:
      "重新计算工作区文档的 sha256，判断已有批注的锚点是否仍对应同一版本。返回每个文件的最新哈希与变化状态。",
    inputSchema: {
      paths: z.array(z.string()).min(1).max(50),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ paths }) => {
    const results = [];
    for (const docPath of paths) {
      try {
        const abs = await resolveDocumentPath(docPath);
        const bytes = await fs.readFile(abs);
        results.push({
          path: isAbsoluteInput(docPath) ? normalizedAbsolute(abs) : toWorkspaceRelative(abs),
          hash: sha256(bytes),
          size: bytes.byteLength,
          missing: false,
        });
      } catch (error) {
        const { message } = describeError(error);
        results.push({ path: docPath, hash: null, missing: true, error: message });
      }
    }
    return okPayload({ documents: results });
  },
);

server.registerTool(
  "load_drafts",
  {
    title: "读取未发送批注",
    description: "读取插件数据目录中保存的待发送批注与最后打开的文档。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async () => {
    const store = await loadDrafts();
    return okPayload({ store, annotationsPath: storePath() });
  },
);

server.registerTool(
  "save_drafts",
  {
    title: "保存待发送批注",
    description: "把当前面板中的批注（草稿与已发送状态）持久化到插件数据目录。",
    inputSchema: {
      annotations: z.array(z.unknown()).max(2000),
      lastDocPath: z.string().optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async ({ annotations, lastDocPath }) => {
    try {
      const store = await saveDrafts({ annotations, lastDocPath });
      return okPayload({ saved: store.annotations.length, updatedAt: store.updatedAt });
    } catch (error) {
      const { code, message } = describeError(error);
      return errorPayload(code, message);
    }
  },
);

server.registerTool(
  "clear_drafts",
  {
    title: "清除批注",
    description: "删除全部待发送批注，或按 id 删除指定批注。",
    inputSchema: {
      ids: z.array(z.string()).optional().describe("要删除的批注 id；省略则清空全部"),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async ({ ids }) => {
    const store = await clearDrafts(ids);
    return okPayload({ remaining: store.annotations.length });
  },
);

server.registerTool(
  "get_workspace_info",
  {
    title: "获取工作区信息",
    description: "返回当前工作区根目录、插件数据路径与支持的文档格式。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async () => {
    return okPayload({
      root: workspaceRoot(),
      name: path.basename(workspaceRoot()),
      workspaceKey: workspaceKey(),
      annotationsPath: storePath(),
      supported: [".md", ".markdown", ".txt", ".pdf", ".docx"],
    });
  },
);

server.registerTool(
  "get_document_status",
  {
    title: "检查单个文档状态",
    description: "读取文档当前哈希与大小，用于判断页面缓存的版本是否过期。",
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async ({ path: docPath }) => {
    try {
      const abs = await resolveDocumentPath(docPath);
      const stat = await fs.stat(abs);
      const bytes = await fs.readFile(abs);
      return okPayload({
        path: isAbsoluteInput(docPath) ? normalizedAbsolute(abs) : toWorkspaceRelative(abs),
        hash: sha256(bytes),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      });
    } catch (error) {
      const { code, message } = describeError(error);
      return errorPayload(code, message);
    }
  },
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const panelMeta = { "zcode/csp": { wasmUnsafeEval: true } };

server.registerResource(
  "panel",
  PANEL_URI,
  { mimeType: HTML_MIME, title: "Document Reviewer", _meta: panelMeta },
  async () => ({
    contents: [
      {
        uri: PANEL_URI,
        mimeType: HTML_MIME,
        text: await fs.readFile(path.join(distRoot, "panel.html"), "utf8"),
        _meta: panelMeta,
      },
    ],
  }),
);

const ASSET_ROOTS = ["pdfjs/cmaps/", "pdfjs/standard_fonts/", "pdfjs/wasm/"];

function resolveAsset(name: string): string | null {
  const normalized = name.replace(/\\/g, "/");
  if (normalized === "pdf-worker.js") return path.join(distRoot, "pdf-worker.js");
  if (!ASSET_ROOTS.some((prefix) => normalized.startsWith(prefix))) return null;
  const abs = path.resolve(distRoot, normalized);
  if (!abs.startsWith(path.resolve(distRoot) + path.sep)) return null;
  return abs;
}

function mimeForAsset(name: string): string {
  if (name.endsWith(".js") || name.endsWith(".mjs")) return "text/javascript";
  if (name.endsWith(".bcmap")) return "application/octet-stream";
  if (name.endsWith(".pfb")) return "application/octet-stream";
  if (name.endsWith(".wasm")) return "application/wasm";
  if (name.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

server.registerResource(
  "assets",
  new ResourceTemplate(`${ASSET_PREFIX}{+name}`, { list: undefined }),
  {},
  async (uri) => {
    const name = decodeURIComponent(uri.href.slice(ASSET_PREFIX.length));
    const abs = resolveAsset(name);
    if (!abs) throw new Error(`Unknown asset: ${name}`);
    const bytes = await fs.readFile(abs);
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: mimeForAsset(name),
          blob: bytes.toString("base64"),
        },
      ],
    };
  },
);

server.registerResource(
  "file",
  new ResourceTemplate(`${FILE_PREFIX}{token}/{index}`, { list: undefined }),
  {},
  async (uri) => {
    const rest = uri.href.slice(FILE_PREFIX.length);
    const match = /^([A-Za-z0-9]+)\/(\d+)$/.exec(rest);
    if (!match) throw new Error(`Invalid file resource: ${uri.href}`);
    const [, token, indexRaw] = match;
    const entry = docCache.get(token);
    if (!entry) throw new Error("文档已关闭或缓存已过期，请重新打开");
    const index = Number(indexRaw);
    const chunkCount = entry.text
      ? Math.ceil(entry.text.length / TEXT_CHUNK_CHARS)
      : Math.ceil(entry.bytes.byteLength / CHUNK_BYTES);
    if (!Number.isInteger(index) || index < 0 || index >= chunkCount) {
      throw new Error(`Chunk out of range: ${index}`);
    }
    if (entry.text !== undefined) {
      const start = index * TEXT_CHUNK_CHARS;
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/plain;charset=utf-8",
            text: entry.text.slice(start, start + TEXT_CHUNK_CHARS),
          },
        ],
      };
    }
    const start = index * CHUNK_BYTES;
    const slice = entry.bytes.subarray(start, Math.min(entry.bytes.byteLength, start + CHUNK_BYTES));
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/pdf",
          blob: slice.toString("base64"),
        },
      ],
    };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[document-reviewer] ready workspace=${workspaceRoot()} dist=${distRoot}\n`,
  );
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`[document-reviewer] uncaught: ${error?.stack || error}\n`);
});
process.on("unhandledRejection", (error) => {
  process.stderr.write(`[document-reviewer] unhandled: ${error}\n`);
});

main().catch((error) => {
  process.stderr.write(`[document-reviewer] fatal: ${error?.stack || error}\n`);
  process.exit(1);
});
