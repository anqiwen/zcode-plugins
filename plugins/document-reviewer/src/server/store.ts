import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Annotation, AnnotationIntent, DraftStore } from "../shared/types.js";
import { workspaceRoot } from "./workspace.js";

const MAX_ANNOTATIONS = 2000;
const MAX_TEXT = 40000;

export function pluginDataDir(): string {
  return (
    process.env.ZCODE_PLUGIN_DATA ||
    path.join(os.homedir(), ".zcode", "plugin-data", "document-reviewer")
  );
}

export function workspaceKey(): string {
  return createHash("sha256").update(workspaceRoot()).digest("hex").slice(0, 16);
}

export function storePath(): string {
  return path.join(pluginDataDir(), "workspaces", workspaceKey(), "drafts.json");
}

function sanitizeString(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function sanitizeAnnotation(raw: unknown): Annotation | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as Record<string, any>;
  if (typeof a.id !== "string" || !a.id) return null;
  if (typeof a.docPath !== "string" || !a.docPath) return null;
  if (!a.anchor || typeof a.anchor !== "object") return null;
  const anchor = a.anchor;
  const base = {
    id: a.id.slice(0, 128),
    docPath: a.docPath.slice(0, 1024),
    docKind: ["md", "txt", "pdf", "docx"].includes(a.docKind) ? a.docKind : "txt",
    docHash: sanitizeString(a.docHash, 128),
    quote: sanitizeString(a.quote),
    comment: sanitizeString(a.comment),
    createdAt: sanitizeString(a.createdAt, 64) || new Date().toISOString(),
    updatedAt: sanitizeString(a.updatedAt, 64) || new Date().toISOString(),
    status: a.status === "sent" ? "sent" : "draft",
    intent: (["edit", "delete", "ask"].includes(a.intent) ? a.intent : "edit") as AnnotationIntent,
    ...(a.stale === true ? { stale: true } : {}),
    ...(typeof a.batchId === "string" ? { batchId: a.batchId.slice(0, 64) } : {}),
    ...(typeof a.sentAt === "string" ? { sentAt: a.sentAt.slice(0, 64) } : {}),
  } satisfies Omit<Annotation, "anchor">;

  if (anchor.kind === "pdf") {
    const page = Number(anchor.page);
    const startItem = Number(anchor.startItem);
    const endItem = Number(anchor.endItem);
    if (!Number.isFinite(page) || page < 1) return null;
    if (!Number.isFinite(startItem) || !Number.isFinite(endItem)) return null;
    const rects = Array.isArray(anchor.rects)
      ? anchor.rects
          .filter(
            (r: any) =>
              r &&
              Number.isFinite(Number(r.x)) &&
              Number.isFinite(Number(r.y)) &&
              Number.isFinite(Number(r.w)) &&
              Number.isFinite(Number(r.h)),
          )
          .slice(0, 400)
          .map((r: any) => ({
            x: Number(r.x),
            y: Number(r.y),
            w: Number(r.w),
            h: Number(r.h),
          }))
      : [];
    return {
      ...base,
      anchor: {
        kind: "pdf",
        page: Math.floor(page),
        startItem: Math.max(0, Math.floor(startItem)),
        endItem: Math.max(0, Math.floor(endItem)),
        startOffset: Math.max(0, Math.floor(Number(anchor.startOffset) || 0)),
        endOffset: Math.max(0, Math.floor(Number(anchor.endOffset) || 0)),
        prefix: sanitizeString(anchor.prefix, 200),
        suffix: sanitizeString(anchor.suffix, 200),
        rects,
      },
    };
  }

  const start = Number(anchor.start);
  const end = Number(anchor.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null;
  }
  const occurrence = Number(anchor.occurrence);
  const paragraph = Number(anchor.paragraph);
  return {
    ...base,
    anchor: {
      kind: "text",
      start: Math.floor(start),
      end: Math.floor(end),
      startLine: Math.max(1, Math.floor(Number(anchor.startLine) || 1)),
      endLine: Math.max(1, Math.floor(Number(anchor.endLine) || 1)),
      prefix: sanitizeString(anchor.prefix, 200),
      suffix: sanitizeString(anchor.suffix, 200),
      ...(Number.isFinite(occurrence) && occurrence >= 0
        ? { occurrence: Math.floor(occurrence) }
        : {}),
      ...(Number.isFinite(paragraph) && paragraph > 0
        ? { paragraph: Math.floor(paragraph) }
        : {}),
    },
  };
}

export async function loadDrafts(): Promise<DraftStore> {
  const file = storePath();
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Record<string, any>;
    const annotations = Array.isArray(parsed.annotations)
      ? parsed.annotations
          .map(sanitizeAnnotation)
          .filter((a): a is Annotation => a !== null)
          .slice(0, MAX_ANNOTATIONS)
      : [];
    return {
      version: 1,
      workspaceKey: workspaceKey(),
      annotations,
      lastDocPath:
        typeof parsed.lastDocPath === "string" ? parsed.lastDocPath : undefined,
      updatedAt:
        typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {
        version: 1,
        workspaceKey: workspaceKey(),
        annotations: [],
        updatedAt: new Date().toISOString(),
      };
    }
    // A corrupt store should not break the panel; keep a backup and start clean.
    try {
      await fs.rename(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* ignore */
    }
    return {
      version: 1,
      workspaceKey: workspaceKey(),
      annotations: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

export async function saveDrafts(input: {
  annotations: unknown;
  lastDocPath?: unknown;
}): Promise<DraftStore> {
  const annotations = Array.isArray(input.annotations)
    ? input.annotations
        .map(sanitizeAnnotation)
        .filter((a): a is Annotation => a !== null)
        .slice(0, MAX_ANNOTATIONS)
    : [];
  const store: DraftStore = {
    version: 1,
    workspaceKey: workspaceKey(),
    annotations,
    lastDocPath:
      typeof input.lastDocPath === "string" ? input.lastDocPath.slice(0, 1024) : undefined,
    updatedAt: new Date().toISOString(),
  };
  const file = storePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, file);
  return store;
}

export async function clearDrafts(ids?: string[]): Promise<DraftStore> {
  const current = await loadDrafts();
  const next = ids && ids.length > 0
    ? current.annotations.filter((annotation) => !ids.includes(annotation.id))
    : [];
  return saveDrafts({ annotations: next, lastDocPath: current.lastDocPath });
}
