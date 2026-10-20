import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DOC_KIND_BY_EXT, type DocKind, type DocumentInfo } from "../shared/types.js";

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".zcode",
  ".agents",
  ".claude",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  "dist",
  "build",
  ".next",
  ".cache",
  "target",
]);

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_LISTED_FILES = 2000;

export class WorkspaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function workspaceRoot(): string {
  const root = process.env.ZCODE_WORKSPACE_ROOT || process.cwd();
  return path.resolve(root);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolves a workspace-relative path and refuses anything that escapes the
 * workspace, including through symlinks. The file must already exist.
 */
export async function resolveWorkspaceFile(input: string): Promise<string> {
  if (typeof input !== "string" || input.trim() === "") {
    throw new WorkspaceError("invalid_path", "缺少文件路径");
  }
  if (input.includes("\0")) {
    throw new WorkspaceError("invalid_path", "路径包含非法字符");
  }
  const root = workspaceRoot();
  const rootReal = await fs.realpath(root);
  const normalizedInput = input.replace(/\\/g, "/").trim();

  // Absolute paths are only accepted when they point inside the workspace.
  const candidate = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(root, normalizedInput);

  if (!isInside(root, candidate)) {
    throw new WorkspaceError("outside_workspace", "只能访问当前工作区内的文件");
  }

  let stat;
  try {
    stat = await fs.stat(candidate);
  } catch {
    throw new WorkspaceError("not_found", `文件不存在：${input}`);
  }
  if (!stat.isFile()) {
    throw new WorkspaceError("not_a_file", `不是文件：${input}`);
  }

  const real = await fs.realpath(candidate);
  if (!isInside(rootReal, real) && !isInside(root, real)) {
    throw new WorkspaceError("outside_workspace", "文件真实路径位于工作区之外");
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new WorkspaceError("too_large", `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB 上限`);
  }
  return candidate;
}

/**
 * Resolves a user-supplied absolute path outside the workspace. This bypasses
 * the workspace root on purpose; callers must only use it after an explicit
 * user action, never for paths the model invents.
 */
export async function resolveExternalFile(input: string): Promise<string> {
  if (typeof input !== "string" || input.trim() === "") {
    throw new WorkspaceError("invalid_path", "缺少文件路径");
  }
  if (input.includes("\0")) {
    throw new WorkspaceError("invalid_path", "路径包含非法字符");
  }
  const normalizedInput = input.replace(/\\/g, "/").trim();
  if (!path.isAbsolute(normalizedInput)) {
    throw new WorkspaceError("absolute_path_required", "请填写文件的绝对路径");
  }
  const candidate = path.resolve(normalizedInput);
  let stat;
  try {
    stat = await fs.stat(candidate);
  } catch {
    throw new WorkspaceError("not_found", `文件不存在：${input}`);
  }
  if (!stat.isFile()) {
    throw new WorkspaceError("not_a_file", `不是文件：${input}`);
  }
  const real = await fs.realpath(candidate);
  const realStat = await fs.stat(real);
  const ext = path.extname(real).toLowerCase();
  if (!DOC_KIND_BY_EXT[ext]) {
    throw new WorkspaceError(
      "unsupported_type",
      `暂不支持 ${ext || "该"} 格式，目前支持 .md / .markdown / .txt / .pdf / .docx`,
    );
  }
  if (realStat.size > MAX_FILE_BYTES) {
    throw new WorkspaceError("too_large", `文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MiB 上限`);
  }
  return real;
}

export function toWorkspaceRelative(abs: string): string {
  return path.relative(workspaceRoot(), abs).replace(/\\/g, "/");
}

export function kindOf(filePath: string): DocKind | null {
  const ext = path.extname(filePath).toLowerCase();
  return DOC_KIND_BY_EXT[ext] ?? null;
}

export function isSupportedDocument(filePath: string): boolean {
  return kindOf(filePath) !== null;
}

async function walk(
  dir: string,
  root: string,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > 12 || out.length >= MAX_LISTED_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= MAX_LISTED_FILES) return;
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs, root, depth + 1, out);
    } else if (entry.isFile() && isSupportedDocument(entry.name)) {
      out.push(path.relative(root, abs).replace(/\\/g, "/"));
    }
  }
}

export async function listDocuments(subdir?: string): Promise<string[]> {
  const root = workspaceRoot();
  let dir = root;
  if (subdir && subdir.trim()) {
    try {
      dir = await resolveWorkspaceFile(subdir.trim());
      // resolveWorkspaceFile requires a file; walk from the parent directory.
      dir = path.dirname(dir);
    } catch {
      const candidate = path.resolve(root, subdir);
      if (!isInside(root, candidate)) {
        throw new WorkspaceError("outside_workspace", "只能访问当前工作区内的文件");
      }
      dir = candidate;
    }
  }
  const out: string[] = [];
  await walk(dir, root, 0, out);
  return out.sort((a, b) => a.localeCompare(b));
}

export function sha256(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface LoadedDocument {
  info: Omit<DocumentInfo, "token" | "chunkCount" | "chunkBytes">;
  bytes: Buffer;
}

export async function loadDocument(
  input: string,
  options?: { external?: boolean },
): Promise<LoadedDocument> {
  const external = options?.external === true;
  const abs = external ? await resolveExternalFile(input) : await resolveWorkspaceFile(input);
  const ext = path.extname(abs).toLowerCase();
  const kind = DOC_KIND_BY_EXT[ext];
  if (!kind) {
    throw new WorkspaceError(
      "unsupported_type",
      `暂不支持 ${ext || "该"} 格式，目前支持 .md / .markdown / .txt / .pdf / .docx`,
    );
  }
  const stat = await fs.stat(abs);
  const bytes = await fs.readFile(abs);
  const rel = external ? abs.replace(/\\/g, "/") : toWorkspaceRelative(abs);
  return {
    bytes,
    info: {
      path: rel,
      name: path.basename(abs),
      ext,
      kind,
      size: bytes.byteLength,
      mtimeMs: stat.mtimeMs,
      hash: sha256(bytes),
      binary: kind === "pdf",
      ...(external ? { external: true } : {}),
    },
  };
}
