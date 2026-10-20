import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Annotation,
  AnnotationIntent,
  DocumentInfo,
  DraftStore,
  TextAnchor,
  WorkspaceInfo,
} from "../shared/types.js";
import {
  annotationIntent,
  buildReviewMessage,
  intentLabel,
  positionLabel,
} from "../shared/message.js";
import type { Bridge } from "./bridge.js";
import { ToolError } from "./bridge.js";
import { MarkdownView } from "./markdown.js";
import { TextView } from "./TextView.js";
import { PdfViewer, resolvePdfSelection, type PdfSelectionResult } from "./PdfViewer.js";
import type { RenderAnnotation } from "./highlight.js";
import {
  buildLineOffsets,
  lineOf,
  makeDocxAnchor,
  makeTextAnchor,
  relocateTextAnchor,
  resolveDomSelection,
} from "./text.js";

type OpenDoc =
  | { kind: "text"; info: DocumentInfo; text: string }
  | { kind: "pdf"; info: DocumentInfo; bytes: Uint8Array };

interface FileEntry {
  path: string;
  name: string;
  kind: string | null;
}

interface PendingTextSelection {
  kind: "text";
  start: number;
  end: number;
  quote: string;
  sourceQuote: string;
  top: number;
  left: number;
}

interface PendingPdfSelection {
  kind: "pdf";
  parts: PdfSelectionResult["parts"];
  quote: string;
  top: number;
  left: number;
}

type PendingSelection = PendingTextSelection | PendingPdfSelection;

interface ComposerState {
  mode: "create" | "edit";
  selection?: PendingSelection;
  annotationId?: string;
  intent: AnnotationIntent;
  value: string;
}

interface InlineEditorState {
  annotationId: string;
  value: string;
  intent: AnnotationIntent;
  top: number;
  left: number;
  width: number;
}

const INTENT_OPTIONS: Array<{ value: AnnotationIntent; label: string; hint: string }> = [
  { value: "edit", label: "修改", hint: "按意见改写选中内容" },
  { value: "delete", label: "删除", hint: "删除选中内容" },
  { value: "ask", label: "疑问", hint: "只提问，不改文件" },
];

interface ToastState {
  kind: "info" | "warn" | "error" | "success";
  text: string;
  action?: { label: string; onClick: () => void };
}

interface ConfirmState {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `a-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function compactPath(path: string, max = 46): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  const name = parts.pop() ?? path;
  return `…/${parts.slice(-1).join("/")}/${name}`.slice(-max);
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//") || value.startsWith("/");
}

function anchorOrder(annotation: Annotation): number {
  if (annotation.anchor.kind === "pdf") {
    return annotation.anchor.page * 1e9 + annotation.anchor.startItem * 1e3 + annotation.anchor.startOffset;
  }
  return annotation.anchor.start;
}

function sortAnnotations(list: Annotation[]): Annotation[] {
  return [...list].sort((a, b) => {
    if (a.docPath !== b.docPath) return a.docPath.localeCompare(b.docPath);
    return anchorOrder(a) - anchorOrder(b);
  });
}

function kindLabel(kind: string | null): string {
  switch (kind) {
    case "md":
      return "MD";
    case "txt":
      return "TXT";
    case "pdf":
      return "PDF";
    case "docx":
      return "DOCX";
    default:
      return "?";
  }
}

function HighlightIcon({ name, size = 16 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "panel-left":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
        </svg>
      );
    case "panel-right":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M15 4v16" />
        </svg>
      );
    case "file":
      return (
        <svg {...common}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <path d="M14 3v5h5" />
        </svg>
      );
    case "folder":
      return (
        <svg {...common}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path d="M21 12a9 9 0 1 1-2.6-6.4" />
          <path d="M21 3v6h-6" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path d="M4 7h16" />
          <path d="M10 11v6M14 11v6" />
          <path d="M6 7l1 13h10l1-13" />
          <path d="M9 7V4h6v3" />
        </svg>
      );
    case "edit":
      return (
        <svg {...common}>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="m22 2-7 20-4-9-9-4z" />
          <path d="M22 2 11 13" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      );
    case "plus":
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );
    case "minus":
      return (
        <svg {...common}>
          <path d="M5 12h14" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      );
    case "check":
      return (
        <svg {...common}>
          <path d="m20 6-11 11-5-5" />
        </svg>
      );
    case "undo":
      return (
        <svg {...common}>
          <path d="M3 7v6h6" />
          <path d="M3.5 13a9 9 0 1 0 2.1-9.4L3 7" />
        </svg>
      );
    case "list":
      return (
        <svg {...common}>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <circle cx="3.5" cy="6" r="1" />
          <circle cx="3.5" cy="12" r="1" />
          <circle cx="3.5" cy="18" r="1" />
        </svg>
      );
    case "chevron-up":
      return (
        <svg {...common}>
          <path d="m6 15 6-6 6 6" />
        </svg>
      );
    case "chevron-down":
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    default:
      return null;
  }
}

export interface ReviewerAppProps {
  bridge: Bridge;
  pendingDocument: DocumentInfo | null;
}

export function ReviewerApp({ bridge, pendingDocument }: ReviewerAppProps) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [fileFilter, setFileFilter] = useState("");
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [viewMode, setViewMode] = useState<"rendered" | "source">("rendered");
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selection, setSelection] = useState<PendingSelection | null>(null);
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [inlineEditor, setInlineEditor] = useState<InlineEditorState | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [showSent, setShowSent] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [overviewFilter, setOverviewFilter] = useState<"all" | "draft" | "sent">("all");
  const [overviewQuery, setOverviewQuery] = useState("");
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [navIndex, setNavIndex] = useState(0);
  const [pathDialogOpen, setPathDialogOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);
  const [pathLoading, setPathLoading] = useState(false);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [pdfZoom, setPdfZoom] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(0);
  const [displayMode, setDisplayMode] = useState<"inline" | "fullscreen" | "pip">(
    bridge.displayMode(),
  );
  const [docError, setDocError] = useState<string | null>(null);
  const [docWarnings, setDocWarnings] = useState<string[]>([]);
  const [lastDocPath, setLastDocPath] = useState<string | null>(null);
  const [refreshHint, setRefreshHint] = useState<{ paths: string[] } | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const navListRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<number>(0);
  const toastTimer = useRef<number>(0);
  const refreshTimer = useRef<number>(0);
  const openedRef = useRef<string | null>(null);

  const drafts = useMemo(
    () => sortAnnotations(annotations.filter((annotation) => annotation.status === "draft")),
    [annotations],
  );
  const sent = useMemo(
    () => sortAnnotations(annotations.filter((annotation) => annotation.status === "sent")),
    [annotations],
  );

  const showToast = useCallback(
    (state: ToastState, timeout = 5200) => {
      window.clearTimeout(toastTimer.current);
      setToast(state);
      if (timeout > 0) {
        toastTimer.current = window.setTimeout(() => setToast(null), timeout);
      }
    },
    [],
  );

  // ----- initial load -------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [info, list, store] = await Promise.all([
          bridge.callTool<WorkspaceInfo>("get_workspace_info"),
          bridge.callTool<{ items: FileEntry[]; total: number }>("list_documents", {
            limit: 500,
          }),
          bridge.callTool<{ store: DraftStore }>("load_drafts"),
        ]);
        if (cancelled) return;
        setWorkspace(info);
        setFiles(list.items);
        setAnnotations(store.store.annotations ?? []);
        setLastDocPath(store.store.lastDocPath ?? null);
        setLoaded(true);
        const lastPath = store.store.lastDocPath;
        const hasUnsentDrafts =
          typeof lastPath === "string" &&
          (store.store.annotations ?? []).some(
            (annotation) =>
              annotation.status === "draft" && annotation.docPath === lastPath,
          );
        if (hasUnsentDrafts) {
          void openDocument(lastPath, {
            silent: true,
            external: isAbsolutePath(lastPath),
          });
        }
      } catch (error: any) {
        if (cancelled) return;
        setLoaded(true);
        setFilesLoading(false);
        showToast({
          kind: "error",
          text: `初始化失败：${error?.message || error}`,
        });
      } finally {
        if (!cancelled) setFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridge]);

  // Open a document requested by an Agent tool call.
  useEffect(() => {
    if (!pendingDocument) return;
    if (openedRef.current === `${pendingDocument.path}:${pendingDocument.hash}`) return;
    openedRef.current = `${pendingDocument.path}:${pendingDocument.hash}`;
    void openDocument(pendingDocument.path, { info: pendingDocument });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDocument]);

  // ----- persistence --------------------------------------------------------
  useEffect(() => {
    if (!loaded) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void bridge
        .callTool("save_drafts", {
          annotations,
          lastDocPath: doc?.info.path,
        })
        .catch((error: any) => {
          showToast({ kind: "warn", text: `批注保存失败：${error?.message || error}` });
        });
    }, 500);
    return () => window.clearTimeout(saveTimer.current);
  }, [annotations, doc?.info.path, loaded, bridge, showToast]);

  useEffect(() => {
    return () => {
      window.clearTimeout(toastTimer.current);
      window.clearTimeout(saveTimer.current);
      window.clearInterval(refreshTimer.current);
    };
  }, []);

  useEffect(() => {
    const handler = (context: { displayMode?: "inline" | "fullscreen" | "pip" }) => {
      if (context?.displayMode) setDisplayMode(context.displayMode);
    };
    bridge.app.addEventListener("hostcontextchanged", handler);
    return () => bridge.app.removeEventListener("hostcontextchanged", handler);
  }, [bridge]);

  // ----- document loading ---------------------------------------------------
  const readChunks = useCallback(
    async (info: DocumentInfo): Promise<OpenDoc> => {
      const parts: (string | Uint8Array)[] = [];
      for (let i = 0; i < info.chunkCount; i += 1) {
        const contents = await bridge.readResource(
          `ui://document-reviewer/file/${info.token}/${i}`,
        );
        if (info.kind === "pdf") {
          if (typeof contents.blob !== "string") throw new ToolError("bad_chunk", "PDF 分片格式错误");
          parts.push(base64ToBytes(contents.blob));
        } else {
          if (typeof contents.text !== "string") throw new ToolError("bad_chunk", "文本分片格式错误");
          parts.push(contents.text);
        }
      }
      if (info.kind === "pdf") {
        const total = (parts as Uint8Array[]).reduce((sum, part) => sum + part.byteLength, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const part of parts as Uint8Array[]) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        return { kind: "pdf", info, bytes };
      }
      return { kind: "text", info, text: (parts as string[]).join("") };
    },
    [bridge],
  );

  const reanchor = useCallback(
    (list: Annotation[], info: DocumentInfo, text: string | null): Annotation[] => {
      return list.map((annotation) => {
        if (annotation.docPath !== info.path) return annotation;
        if (annotation.docHash === info.hash) {
          return annotation.stale ? { ...annotation, stale: false } : annotation;
        }
        if (annotation.anchor.kind === "text" && text !== null) {
          const found = relocateTextAnchor(text, annotation.anchor, annotation.quote);
          if (found) {
            return {
              ...annotation,
              anchor: found.anchor,
              docHash: info.hash,
              stale: !found.exact,
              quote: found.exact
                ? annotation.quote
                : text.slice(found.anchor.start, found.anchor.end).replace(/\s+/g, " ").trim(),
            };
          }
        }
        return { ...annotation, stale: true };
      });
    },
    [],
  );

  const openDocument = useCallback(
    async (
      path: string,
      options?: {
        silent?: boolean;
        info?: DocumentInfo;
        external?: boolean;
        throwOnError?: boolean;
      },
    ) => {
      setDocLoading(true);
      setDocError(null);
      setDocWarnings([]);
      setRefreshHint(null);
      setSelection(null);
      setComposer(null);
      setInlineEditor(null);
      try {
        let info = options?.info;
        if (!info) {
          const opened = await bridge.callTool<{ document: DocumentInfo }>(
            options?.external ? "open_external_document" : "open_document",
            { path },
          );
          info = opened.document;
        }
        const document = await readChunks(info);
        setDoc(document);
        setViewMode("rendered");
        setPdfZoom(1);
        setPdfPageCount(0);
        setLastDocPath(info.path);
        setAnnotations((current) =>
          reanchor(current, info!, document.kind === "text" ? document.text : null),
        );
        setDocWarnings(info.warnings ?? []);
        openedRef.current = `${info.path}:${info.hash}`;
      } catch (error: any) {
        const message = error?.message || String(error);
        setDocError(message);
        if (!options?.silent) showToast({ kind: "error", text: `打开失败：${message}` });
        if (options?.throwOnError) throw error;
      } finally {
        setDocLoading(false);
      }
    },
    [bridge, readChunks, reanchor, showToast],
  );

  // ----- selection ----------------------------------------------------------
  const resolveTextSelection = useCallback(() => {
    if (!doc || doc.kind !== "text") return;
    const root = textRef.current;
    if (!root) return;
    const resolved = resolveDomSelection(root, doc.text, {
      quoteFromSelection:
        doc.info.kind === "docx" || (doc.info.kind === "md" && viewMode === "rendered"),
    });
    if (!resolved) {
      setSelection(null);
      return;
    }
    const domSelection = window.getSelection();
    const rect = domSelection && domSelection.rangeCount > 0
      ? domSelection.getRangeAt(0).getBoundingClientRect()
      : null;
    setSelection({
      kind: "text",
      start: resolved.start,
      end: resolved.end,
      quote: resolved.quote,
      sourceQuote: resolved.sourceQuote,
      top: rect ? Math.max(8, rect.top - 44) : 80,
      left: rect ? Math.max(8, Math.min(window.innerWidth - 140, rect.left + rect.width / 2 - 60)) : 80,
    });
  }, [doc, viewMode]);

  useEffect(() => {
    const root = textRef.current;
    if (!root) return;
    const handler = () => {
      window.setTimeout(resolveTextSelection, 0);
    };
    root.addEventListener("mouseup", handler);
    root.addEventListener("keyup", handler);
    return () => {
      root.removeEventListener("mouseup", handler);
      root.removeEventListener("keyup", handler);
    };
  }, [resolveTextSelection]);

  const handlePdfSelection = useCallback(
    (result: PdfSelectionResult | null) => {
      if (!result) {
        setSelection(null);
        return;
      }
      const domSelection = window.getSelection();
      const rect = domSelection && domSelection.rangeCount > 0
        ? domSelection.getRangeAt(0).getBoundingClientRect()
        : null;
      setSelection({
        kind: "pdf",
        parts: result.parts,
        quote: result.rawQuote,
        top: rect ? Math.max(8, rect.top - 44) : 80,
        left: rect ? Math.max(8, Math.min(window.innerWidth - 140, rect.left + rect.width / 2 - 60)) : 80,
      });
    },
    [],
  );

  const findAnnotationElement = useCallback((id: string): HTMLElement | null => {
    const escaped = CSS.escape(id);
    return (
      textRef.current?.querySelector<HTMLElement>(
        `mark[data-annotation-id="${escaped}"]`,
      ) ??
      viewerRef.current?.querySelector<HTMLElement>(
        `.pdf-pin[data-annotation-id="${escaped}"], .pdf-hl[data-annotation-id="${escaped}"]`,
      ) ??
      viewerRef.current?.querySelector<HTMLElement>(
        `.annotation-pin[data-annotation-id="${escaped}"]`,
      ) ??
      null
    );
  }, []);

  const openInlineEditor = useCallback(
    (annotation: Annotation) => {
      const element = findAnnotationElement(annotation.id);
      const rect = element?.getBoundingClientRect();
      const width = Math.min(340, window.innerWidth - 20);
      const estimatedHeight = 230;
      let left = rect ? rect.left : window.innerWidth / 2 - width / 2;
      let top = rect ? rect.bottom + 8 : 96;
      left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
      if (top + estimatedHeight > window.innerHeight - 8) {
        top = rect ? Math.max(8, rect.top - estimatedHeight - 8) : 96;
      }
      setNavigatorOpen(false);
      setActiveId(annotation.id);
      setInlineEditor({
        annotationId: annotation.id,
        value: annotation.comment,
        intent: annotationIntent(annotation),
        top,
        left,
        width,
      });
    },
    [findAnnotationElement],
  );

  const handleMarkClick = useCallback(
    (id: string) => {
      setActiveId(id);
      const annotation = annotations.find((item) => item.id === id);
      if (annotation) openInlineEditor(annotation);
    },
    [annotations, openInlineEditor],
  );
  const handlePdfError = useCallback((message: string) => setDocError(message), []);

  useEffect(() => {
    if (!activeId || !doc || doc.kind !== "text" || inlineEditor) return;
    const timer = window.setTimeout(() => {
      const mark = textRef.current?.querySelector(
        `mark[data-annotation-id="${CSS.escape(activeId)}"]`,
      );
      mark?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [activeId, doc, inlineEditor]);

  // ----- annotations --------------------------------------------------------
  const openComposerForSelection = () => {
    if (!selection) return;
    setComposer({ mode: "create", selection, intent: "edit", value: "" });
  };

  const openComposerForEdit = (annotation: Annotation) => {
    setInlineEditor(null);
    setComposer({
      mode: "edit",
      annotationId: annotation.id,
      intent: annotationIntent(annotation),
      value: annotation.comment,
    });
  };

  const saveComposer = () => {
    if (!composer) return;
    const raw = composer.value.trim();
    const value = raw || (composer.intent === "delete" ? "删除这段内容" : "");
    if (!value || !doc) return;
    const now = new Date().toISOString();

    if (composer.mode === "edit" && composer.annotationId) {
      setAnnotations((current) =>
        current.map((annotation) =>
          annotation.id === composer.annotationId
            ? {
                ...annotation,
                comment: value,
                intent: composer.intent,
                updatedAt: now,
              }
            : annotation,
        ),
      );
      setComposer(null);
      showToast({ kind: "success", text: "批注已更新" }, 2200);
      return;
    }

    const pending = composer.selection;
    if (!pending) return;
    const created: Annotation[] = [];
    if (pending.kind === "text") {
      const source = doc.kind === "text" ? doc.text : "";
      const anchor: TextAnchor =
        doc.info.kind === "docx"
          ? makeDocxAnchor(source, pending.start, pending.end, pending.quote)
          : makeTextAnchor(source, pending.start, pending.end);
      created.push({
        id: uid(),
        docPath: doc.info.path,
        docKind: doc.info.kind,
        docHash: doc.info.hash,
        quote: pending.quote || pending.sourceQuote,
        comment: value,
        intent: composer.intent,
        anchor,
        createdAt: now,
        updatedAt: now,
        status: "draft",
      });
    } else {
      const partCount = pending.parts.length;
      for (const [index, part] of pending.parts.entries()) {
        const prefix = pending.parts[index - 1]?.quote.slice(-40) ?? "";
        const suffix = pending.parts[index + 1]?.quote.slice(0, 40) ?? "";
        created.push({
          id: uid(),
          docPath: doc.info.path,
          docKind: doc.info.kind,
          docHash: doc.info.hash,
          quote: part.quote,
          comment: value,
          intent: composer.intent,
          anchor: {
            kind: "pdf",
            page: part.page,
            startItem: part.startItem,
            endItem: part.endItem,
            startOffset: part.startOffset,
            endOffset: part.endOffset,
            prefix,
            suffix,
            rects: part.rects,
          },
          createdAt: now,
          updatedAt: now,
          status: "draft",
        });
      }
      if (partCount > 1) {
        showToast({
          kind: "info",
          text: `选区跨 ${partCount} 页，已拆分为 ${partCount} 条批注`,
        });
      }
    }
    setAnnotations((current) => [...current, ...created]);
    setComposer(null);
    setSelection(null);
    window.getSelection()?.removeAllRanges();
    showToast(
      { kind: "success", text: created.length > 1 ? `已添加 ${created.length} 条批注` : "已添加批注" },
      2200,
    );
  };

  const deleteAnnotation = (annotation: Annotation) => {
    const index = annotations.findIndex((item) => item.id === annotation.id);
    setAnnotations((current) => current.filter((item) => item.id !== annotation.id));
    if (activeId === annotation.id) setActiveId(null);
    if (inlineEditor?.annotationId === annotation.id) setInlineEditor(null);
    showToast(
      {
        kind: "info",
        text: "已删除 1 条批注",
        action: {
          label: "撤销",
          onClick: () => {
            setAnnotations((current) => {
              if (current.some((item) => item.id === annotation.id)) return current;
              const next = [...current];
              next.splice(Math.max(0, Math.min(index, next.length)), 0, annotation);
              return next;
            });
            setToast(null);
          },
        },
      },
      8000,
    );
  };

  const saveInlineEditor = () => {
    if (!inlineEditor) return;
    const raw = inlineEditor.value.trim();
    const value = raw || (inlineEditor.intent === "delete" ? "删除这段内容" : "");
    if (!value) return;
    const now = new Date().toISOString();
    setAnnotations((current) =>
      current.map((annotation) =>
        annotation.id === inlineEditor.annotationId
          ? {
              ...annotation,
              comment: value,
              intent: inlineEditor.intent,
              updatedAt: now,
            }
          : annotation,
      ),
    );
    setInlineEditor(null);
    showToast({ kind: "success", text: "批注已更新" }, 2200);
  };

  const deleteInlineEditor = () => {
    if (!inlineEditor) return;
    const annotation = annotations.find(
      (item) => item.id === inlineEditor.annotationId,
    );
    setInlineEditor(null);
    if (annotation) deleteAnnotation(annotation);
  };

  const clearDrafts = () => {
    if (drafts.length === 0) return;
    setConfirmState({
      title: "清空全部待发送批注",
      body: `将删除 ${drafts.length} 条待发送批注，已发送记录会保留。此操作可以撤销一次。`,
      confirmLabel: "清空",
      danger: true,
      onConfirm: () => {
        const snapshot = annotations;
        setAnnotations((current) => current.filter((item) => item.status === "sent"));
        setConfirmState(null);
        showToast(
          {
            kind: "info",
            text: `已清空 ${drafts.length} 条待发送批注`,
            action: {
              label: "撤销",
              onClick: () => {
                setAnnotations(snapshot);
                setToast(null);
              },
            },
          },
          8000,
        );
      },
    });
  };

  const scrollToAnnotation = (annotation: Annotation) => {
    setInlineEditor(null);
    setActiveId(annotation.id);
  };

  const jumpToAnnotation = async (annotation: Annotation) => {
    setInlineEditor(null);
    setOverviewOpen(false);
    if (doc?.info.path !== annotation.docPath) {
      await openDocument(annotation.docPath, {
        silent: true,
        external: isAbsolutePath(annotation.docPath),
      });
    }
    setActiveId(annotation.id);
    if (annotation.anchor.kind === "text") {
      window.setTimeout(() => {
        const mark = textRef.current?.querySelector(
          `mark[data-annotation-id="${CSS.escape(annotation.id)}"]`,
        );
        mark?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 350);
    }
  };

  const openOverview = () => {
    setInlineEditor(null);
    setNavigatorOpen(false);
    setOverviewFilter("all");
    setOverviewQuery("");
    setOverviewOpen(true);
  };

  const copyAllAnnotations = async () => {
    const lines: string[] = ["# 批注清单", ""];
    const byFile = new Map<string, Annotation[]>();
    for (const annotation of sortAnnotations(annotations)) {
      const list = byFile.get(annotation.docPath) ?? [];
      list.push(annotation);
      byFile.set(annotation.docPath, list);
    }
    for (const [file, items] of byFile) {
      lines.push(`## ${file}`);
      for (const annotation of items) {
        const number = numberById.get(annotation.id) ?? "·";
        const status =
          annotation.status === "sent"
            ? "已发送"
            : annotation.stale
              ? "待发送（位置待核对）"
              : "待发送";
        lines.push("");
        lines.push(`### 批注 ${number} · ${status}`);
        lines.push(`意图：${intentLabel(annotationIntent(annotation))}`);
        lines.push(`位置：${positionLabel(annotation)}`);
        lines.push(`原文：${annotation.quote}`);
        lines.push(`意见：${annotation.comment}`);
        lines.push(`创建：${new Date(annotation.createdAt).toLocaleString("zh-CN")}`);
      }
      lines.push("");
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      showToast({ kind: "success", text: `已复制 ${annotations.length} 条批注` }, 2200);
    } catch {
      showToast({ kind: "warn", text: "剪贴板不可用，请手动复制" });
    }
  };

  const overviewItems = useMemo(() => {
    const keyword = overviewQuery.trim().toLowerCase();
    return sortAnnotations(annotations).filter((annotation) => {
      if (overviewFilter === "draft" && annotation.status !== "draft") return false;
      if (overviewFilter === "sent" && annotation.status !== "sent") return false;
      if (!keyword) return true;
      return (
        annotation.quote.toLowerCase().includes(keyword) ||
        annotation.comment.toLowerCase().includes(keyword) ||
        annotation.docPath.toLowerCase().includes(keyword)
      );
    });
  }, [annotations, overviewFilter, overviewQuery]);

  const overviewGroups = useMemo(() => {
    const groups = new Map<string, Annotation[]>();
    for (const annotation of overviewItems) {
      const list = groups.get(annotation.docPath) ?? [];
      list.push(annotation);
      groups.set(annotation.docPath, list);
    }
    return [...groups.entries()];
  }, [overviewItems]);

  // ----- send ---------------------------------------------------------------
  const markSent = (targets: Annotation[]) => {
    const batchId = uid();
    const now = new Date().toISOString();
    const ids = new Set(targets.map((annotation) => annotation.id));
    setAnnotations((current) =>
      current.map((annotation) =>
        ids.has(annotation.id)
          ? { ...annotation, status: "sent", batchId, sentAt: now, stale: false }
          : annotation,
      ),
    );
  };

  const startRefreshWatch = useCallback(
    (documents: Array<{ path: string; hash: string }>) => {
      window.clearInterval(refreshTimer.current);
      const expected = new Map(
        documents.filter((doc) => doc.hash).map((doc) => [doc.path, doc.hash]),
      );
      if (expected.size === 0) return;
      const startedAt = Date.now();
      const check = async () => {
        try {
          const checked = await bridge.callTool<{
            documents: Array<{ path: string; hash: string | null; missing: boolean }>;
          }>("check_documents", { paths: [...expected.keys()] });
          const changed = checked.documents.filter(
            (entry) =>
              entry.missing ||
              (entry.hash && expected.get(entry.path) !== entry.hash),
          );
          if (changed.length > 0) {
            setRefreshHint({ paths: changed.map((entry) => entry.path) });
            window.clearInterval(refreshTimer.current);
          } else if (Date.now() - startedAt > 10 * 60 * 1000) {
            window.clearInterval(refreshTimer.current);
          }
        } catch {
          // The agent may be writing the file; keep polling briefly.
        }
      };
      void check();
      refreshTimer.current = window.setInterval(check, 5000);
    },
    [bridge],
  );

  const performSend = async (targets: Annotation[], allowedStale: boolean) => {
    if (targets.length === 0) return;
    setSending(true);
    try {
      const paths = [...new Set(targets.map((annotation) => annotation.docPath))];
      let fresh: Array<{ path: string; hash: string | null; missing: boolean }> = [];
      try {
        const checked = await bridge.callTool<{
          documents: Array<{ path: string; hash: string | null; missing: boolean }>;
        }>("check_documents", { paths });
        fresh = checked.documents;
        const changed = checked.documents.filter(
          (entry) =>
            entry.missing ||
            (entry.hash && targets.some(
              (annotation) => annotation.docPath === entry.path && annotation.docHash !== entry.hash,
            )),
        );
        if (changed.length > 0 && !allowedStale) {
          const names = changed.map((entry) => entry.path).join("、");
          setConfirmState({
            title: "文档已发生变化",
            body: `${names} 在批注创建后已被修改或删除。发送前请确认批注位置仍然正确；Agent 会以最新文件为准，但可能无法定位旧选区。`,
            confirmLabel: "仍然发送",
            danger: true,
            onConfirm: () => {
              setConfirmState(null);
              void performSend(targets, true);
            },
          });
          return;
        }
      } catch {
        // Hash check is a safety net; do not block sending if it fails.
      }

      const documents = paths.map((path) => ({
        path,
        hash: fresh.find((entry) => entry.path === path)?.hash ?? "",
      }));
      const message = buildReviewMessage(
        targets.map((annotation) =>
          fresh.some((entry) => entry.path === annotation.docPath && entry.hash && entry.hash !== annotation.docHash)
            ? { ...annotation, stale: true }
            : annotation,
        ),
        documents,
      );

      if (bridge.capabilities.message) {
        await bridge.sendMessage(message);
        markSent(targets);
        startRefreshWatch(documents);
        setPreviewOpen(false);
        showToast({
          kind: "success",
          text: `已把 ${targets.length} 条批注发送给主 Agent，修改完成后会提示刷新`,
        });
        return;
      }

      if (bridge.capabilities.updateModelContext) {
        await bridge.updateModelContext(message, {
          kind: "document-reviewer-batch",
          count: targets.length,
          documents,
        });
        setPreviewOpen(false);
        showToast(
          {
            kind: "warn",
            text: "当前宿主不支持直接发送，批注已填入对话上下文，请在输入区确认后手动发送。",
          },
          9000,
        );
        return;
      }

      setPreviewOpen(true);
      showToast({
        kind: "error",
        text: "当前宿主没有可用的发送或上下文接口，请复制下方内容到对话。",
      });
    } catch (error: any) {
      const message = error?.message || String(error);
      const unavailable =
        error instanceof ToolError ||
        /not available|not supported|-32601|不支持/i.test(message);
      if (unavailable && bridge.capabilities.updateModelContext) {
        try {
          const fallbackText = buildReviewMessage(targets, []);
          await bridge.updateModelContext(fallbackText, { kind: "document-reviewer-batch" });
          setPreviewOpen(false);
          showToast({
            kind: "warn",
            text: "直接发送失败，已降级为填入对话上下文，请手动确认发送。",
          });
          return;
        } catch {
          /* fall through */
        }
      }
      showToast({ kind: "error", text: `发送失败：${message}` }, 0);
    } finally {
      setSending(false);
    }
  };

  const handleSend = () => {
    if (drafts.length === 0 || sending) return;
    setInlineEditor(null);
    setNavigatorOpen(false);
    void performSend(drafts, false);
  };

  const refreshChanged = async () => {
    const paths = refreshHint?.paths ?? [];
    if (paths.length === 0) return;
    const currentPath = doc?.info.path;
    const target = currentPath && paths.includes(currentPath) ? currentPath : paths[0];
    setRefreshHint(null);
    await openDocument(target, {
      silent: true,
      external: isAbsolutePath(target),
    });
    showToast({ kind: "success", text: "已刷新文档并重新核对批注位置" }, 2600);
  };

  const openPathDialog = () => {
    setInlineEditor(null);
    setNavigatorOpen(false);
    setPathInput("");
    setPathError(null);
    setPathLoading(false);
    setPathDialogOpen(true);
  };

  const submitExternalPath = async () => {
    const value = pathInput.trim();
    if (!value || pathLoading) return;
    setPathLoading(true);
    setPathError(null);
    try {
      await openDocument(value, {
        external: true,
        silent: true,
        throwOnError: true,
      });
      setPathDialogOpen(false);
      setPathInput("");
      showToast({ kind: "success", text: "已打开外部文件" }, 2200);
    } catch (error: any) {
      setDocError(null);
      setPathError(error?.message || String(error));
    } finally {
      setPathLoading(false);
    }
  };

  const browseExternalFile = async () => {
    if (browseLoading || pathLoading) return;
    setBrowseLoading(true);
    setPathError(null);
    try {
      const picked = await bridge.callTool<{ path: string | null }>(
        "pick_external_document",
      );
      if (!picked.path) return;
      setPathInput(picked.path);
      await openDocument(picked.path, {
        external: true,
        silent: true,
        throwOnError: true,
      });
      setPathDialogOpen(false);
      showToast({ kind: "success", text: "已打开外部文件" }, 2200);
    } catch (error: any) {
      setDocError(null);
      setPathError(error?.message || String(error));
    } finally {
      setBrowseLoading(false);
    }
  };

  const previewText = useMemo(() => {
    const targets = drafts;
    const paths = [...new Set(targets.map((annotation) => annotation.docPath))];
    return buildReviewMessage(
      targets,
      paths.map((path) => ({
        path,
        hash: targets.find((annotation) => annotation.docPath === path)?.docHash ?? "",
      })),
    );
  }, [drafts]);

  const copyPreview = async () => {
    try {
      await navigator.clipboard.writeText(previewText);
      showToast({ kind: "success", text: "已复制到剪贴板" }, 2200);
    } catch {
      showToast({ kind: "warn", text: "剪贴板不可用，请手动选择文本复制" });
    }
  };

  // ----- rendering helpers --------------------------------------------------
  const refreshFiles = async () => {
    setFilesLoading(true);
    try {
      const list = await bridge.callTool<{ items: FileEntry[] }>("list_documents", { limit: 500 });
      setFiles(list.items);
      showToast({ kind: "success", text: `已刷新，共 ${list.items.length} 篇文档` }, 2000);
    } catch (error: any) {
      showToast({ kind: "error", text: `刷新失败：${error?.message || error}` });
    } finally {
      setFilesLoading(false);
    }
  };

  const filteredFiles = useMemo(() => {
    const keyword = fileFilter.trim().toLowerCase();
    if (!keyword) return files;
    return files.filter((file) => file.path.toLowerCase().includes(keyword));
  }, [files, fileFilter]);

  const currentDocDrafts = useMemo(
    () => drafts.filter((annotation) => annotation.docPath === doc?.info.path),
    [drafts, doc?.info.path],
  );

  const numberById = useMemo(() => {
    const map = new Map<string, number>();
    sortAnnotations(annotations).forEach((annotation, index) => map.set(annotation.id, index + 1));
    return map;
  }, [annotations]);

  const navigatorItems = useMemo(
    () => (doc && currentDocDrafts.length > 0 ? currentDocDrafts : drafts),
    [currentDocDrafts, doc, drafts],
  );
  const navigatorScope = doc && currentDocDrafts.length > 0 ? "doc" : "all";

  const selectNavigatorItem = useCallback(
    (index: number, jump = true) => {
      if (navigatorItems.length === 0) return;
      const next = Math.max(0, Math.min(navigatorItems.length - 1, index));
      setNavIndex(next);
      if (jump) void jumpToAnnotation(navigatorItems[next]);
    },
    [jumpToAnnotation, navigatorItems],
  );

  const toggleNavigator = () => {
    if (navigatorOpen) {
      setNavigatorOpen(false);
      return;
    }
    if (navigatorItems.length === 0) return;
    setInlineEditor(null);
    const activeIndex = navigatorItems.findIndex((annotation) => annotation.id === activeId);
    setNavIndex(activeIndex >= 0 ? activeIndex : 0);
    setNavigatorOpen(true);
  };

  useEffect(() => {
    if (drafts.length === 0) setNavigatorOpen(false);
  }, [drafts.length]);

  useEffect(() => {
    if (navIndex >= navigatorItems.length) {
      setNavIndex(Math.max(0, navigatorItems.length - 1));
    }
  }, [navIndex, navigatorItems.length]);

  useEffect(() => {
    if (!navigatorOpen) return;
    const index = navigatorItems.findIndex((annotation) => annotation.id === activeId);
    if (index >= 0) setNavIndex(index);
  }, [activeId, navigatorItems, navigatorOpen]);

  useEffect(() => {
    if (!navigatorOpen) return;
    const item = navListRef.current?.querySelector<HTMLElement>(
      `[data-nav-index="${navIndex}"]`,
    );
    item?.scrollIntoView({ block: "nearest" });
  }, [navIndex, navigatorOpen]);

  useEffect(() => {
    if (!navigatorOpen) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".annotation-nav") || target?.closest(".draft-count")) return;
      setNavigatorOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [navigatorOpen]);

  useEffect(() => {
    if (!inlineEditor) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".inline-editor")) return;
      if (
        target?.closest("mark.hl") ||
        target?.closest(".pdf-pin") ||
        target?.closest(".pdf-hl") ||
        target?.closest(".annotation-pin") ||
        target?.closest(".annotation-card")
      ) {
        return;
      }
      setInlineEditor(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [inlineEditor]);

  useEffect(() => {
    if (!inlineEditor) return;
    const close = () => setInlineEditor(null);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("resize", close);
    };
  }, [inlineEditor]);

  useEffect(() => {
    if (
      inlineEditor &&
      !annotations.some((annotation) => annotation.id === inlineEditor.annotationId)
    ) {
      setInlineEditor(null);
    }
  }, [annotations, inlineEditor]);

  const composerSelection = composer?.mode === "create" ? composer.selection : undefined;
  const composerIntent: AnnotationIntent = composer?.intent ?? "edit";
  const renderAnnotations = useMemo<RenderAnnotation[]>(() => {
    if (!composerSelection || !doc) return annotations;
    const now = new Date().toISOString();
    const pending: RenderAnnotation[] = [];
    if (composerSelection.kind === "text" && doc.kind === "text") {
      const anchor =
        doc.info.kind === "docx"
          ? makeDocxAnchor(
              doc.text,
              composerSelection.start,
              composerSelection.end,
              composerSelection.quote,
            )
          : makeTextAnchor(doc.text, composerSelection.start, composerSelection.end);
      pending.push({
        id: "__pending__",
        docPath: doc.info.path,
        docKind: doc.info.kind,
        docHash: doc.info.hash,
        quote: composerSelection.quote || composerSelection.sourceQuote,
        comment: "",
        intent: composerIntent,
        anchor,
        createdAt: now,
        updatedAt: now,
        status: "draft",
        pending: true,
      });
    } else if (composerSelection.kind === "pdf" && doc.kind === "pdf") {
      composerSelection.parts.forEach((part, index) => {
        pending.push({
          id: `__pending-${index}`,
          docPath: doc.info.path,
          docKind: doc.info.kind,
          docHash: doc.info.hash,
          quote: part.quote,
          comment: "",
          intent: composerIntent,
          anchor: {
            kind: "pdf",
            page: part.page,
            startItem: part.startItem,
            endItem: part.endItem,
            startOffset: part.startOffset,
            endOffset: part.endOffset,
            prefix: "",
            suffix: "",
            rects: part.rects,
          },
          createdAt: now,
          updatedAt: now,
          status: "draft",
          pending: true,
        });
      });
    }
    return pending.length > 0 ? [...annotations, ...pending] : annotations;
  }, [annotations, composerIntent, composerSelection, doc]);

  const docRevision = doc ? `${doc.info.path}:${doc.info.hash}` : undefined;

  const selectionLine = useMemo(() => {
    if (!selection || selection.kind !== "text" || !doc || doc.kind !== "text") return null;
    const offsets = buildLineOffsets(doc.text);
    const startLine = lineOf(offsets, selection.start);
    const endLine = lineOf(offsets, Math.max(selection.start, selection.end - 1));
    return startLine === endLine
      ? `第 ${startLine} 行`
      : `第 ${startLine}–${endLine} 行`;
  }, [selection, doc]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(
        element &&
          (element.tagName === "INPUT" ||
            element.tagName === "TEXTAREA" ||
            element.isContentEditable),
      );
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (composer) {
          setComposer(null);
        } else if (previewOpen) {
          setPreviewOpen(false);
        } else if (confirmState) {
          setConfirmState(null);
        } else if (pathDialogOpen) {
          setPathDialogOpen(false);
        } else if (inlineEditor) {
          setInlineEditor(null);
        } else if (navigatorOpen) {
          setNavigatorOpen(false);
        } else if (selection) {
          setSelection(null);
        }
        return;
      }
      if (navigatorOpen) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (isEditable(event.target)) return;
          event.preventDefault();
          selectNavigatorItem(navIndex + (event.key === "ArrowDown" ? 1 : -1));
          return;
        }
        if (event.key === "Enter") {
          if (isEditable(event.target)) return;
          event.preventDefault();
          const item = navigatorItems[navIndex];
          if (item) void jumpToAnnotation(item);
          setNavigatorOpen(false);
          return;
        }
        return;
      }
      if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        if (isEditable(event.target) || navigatorItems.length === 0) return;
        event.preventDefault();
        const current = activeId
          ? navigatorItems.findIndex((annotation) => annotation.id === activeId)
          : -1;
        const base =
          current >= 0
            ? current
            : event.key === "ArrowDown"
              ? -1
              : navigatorItems.length;
        const next = Math.max(
          0,
          Math.min(
            navigatorItems.length - 1,
            base + (event.key === "ArrowDown" ? 1 : -1),
          ),
        );
        const item = navigatorItems[next];
        if (item) {
          setNavIndex(next);
          void jumpToAnnotation(item);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    activeId,
    composer,
    confirmState,
    inlineEditor,
    jumpToAnnotation,
    navIndex,
    navigatorItems,
    navigatorOpen,
    pathDialogOpen,
    previewOpen,
    selectNavigatorItem,
    selection,
  ]);

  const inlineAnnotation = inlineEditor
    ? annotations.find((annotation) => annotation.id === inlineEditor.annotationId) ?? null
    : null;

  const composerElement = composer ? (
    <div className="composer-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) setComposer(null);
    }}>
      <div className="composer">
        <div className="composer-head">
          <span>{composer.mode === "edit" ? "编辑批注" : "添加批注"}</span>
          <button className="icon-btn" onClick={() => setComposer(null)} title="取消">
            <HighlightIcon name="x" />
          </button>
        </div>
        {composer.mode === "create" && composer.selection ? (
          <div className="composer-quote">
            <div className="composer-quote-label">
              选中原文{selectionLine ? ` · ${selectionLine}` : ""}
            </div>
            <div className="composer-quote-text">{composer.selection.quote}</div>
          </div>
        ) : null}
        <div className="intent-chips" role="group" aria-label="批注意图">
          {INTENT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`intent-chip intent-${option.value}${
                composer.intent === option.value ? " is-on" : ""
              }`}
              title={option.hint}
              aria-pressed={composer.intent === option.value}
              onClick={() =>
                setComposer((current) =>
                  current ? { ...current, intent: option.value } : current,
                )
              }
            >
              {option.label}
            </button>
          ))}
          <span className="hint">
            {INTENT_OPTIONS.find((option) => option.value === composer.intent)?.hint}
          </span>
        </div>
        <textarea
          autoFocus
          className="composer-input"
          placeholder={
            composer.intent === "delete"
              ? "可补充删除原因（可留空）；保存后 Agent 会删除选中内容。"
              : composer.intent === "ask"
                ? "写下你的疑问，例如：这里的样本量依据是什么？"
                : "写下修改意见，例如：这段结论与第 3 节的数据不一致，请给出解释或修改。"
          }
          value={composer.value}
          onChange={(event) =>
            setComposer((current) => (current ? { ...current, value: event.target.value } : current))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              saveComposer();
            }
          }}
        />
        <div className="composer-foot">
          <span className="hint">Ctrl+Enter 保存 · Esc 取消</span>
          <div className="composer-actions">
            <button className="btn" onClick={() => setComposer(null)}>
              取消
            </button>
            <button
              className="btn primary"
              disabled={!composer.value.trim() && composer.intent !== "delete"}
              onClick={saveComposer}
            >
              {composer.mode === "edit" ? "保存修改" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <button
            className={`icon-btn${leftOpen ? " active" : ""}`}
            title="文件列表"
            onClick={() => setLeftOpen((value) => !value)}
          >
            <HighlightIcon name="panel-left" />
          </button>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <HighlightIcon name="file" size={14} />
            </span>
            <span className="brand-text">
              <span className="brand-title">文档批注</span>
              <span className="brand-sub">Document Reviewer</span>
            </span>
          </div>
          {workspace ? <span className="workspace-chip">{workspace.name}</span> : null}
        </div>
        <div className="topbar-center">
          {doc ? (
            <>
              <span className="doc-title" title={doc.info.path}>
                {doc.info.name}
              </span>
              <span className="doc-path" title={doc.info.path}>
                {compactPath(doc.info.path)}
              </span>
              {doc.info.kind === "md" ? (
                <div className="segmented">
                  <button
                    className={viewMode === "rendered" ? "active" : ""}
                    onClick={() => setViewMode("rendered")}
                  >
                    渲染
                  </button>
                  <button
                    className={viewMode === "source" ? "active" : ""}
                    onClick={() => setViewMode("source")}
                  >
                    源码
                  </button>
                </div>
              ) : null}
              {doc.info.kind === "pdf" ? (
                <div className="zoom-controls">
                  <button
                    className="icon-btn"
                    onClick={() => setPdfZoom((value) => Math.max(0.4, Number((value - 0.1).toFixed(2))))}
                    title="缩小"
                  >
                    <HighlightIcon name="minus" />
                  </button>
                  <span className="zoom-label">{Math.round(pdfZoom * 100)}%</span>
                  <button
                    className="icon-btn"
                    onClick={() => setPdfZoom((value) => Math.min(3, Number((value + 0.1).toFixed(2))))}
                    title="放大"
                  >
                    <HighlightIcon name="plus" />
                  </button>
                  {pdfPageCount > 0 ? (
                    <span className="page-count">{pdfPageCount} 页</span>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <span className="doc-title muted">未打开文档</span>
          )}
        </div>
        <div className="topbar-right">
          <button className="icon-btn" title="全部批注" onClick={openOverview}>
            <HighlightIcon name="list" />
          </button>
          {displayMode === "inline" ? (
            <button
              className="icon-btn"
              title="展开到侧栏"
              onClick={() => void bridge.requestFullscreen()}
            >
              <HighlightIcon name="panel-right" />
            </button>
          ) : null}
          <button
            className={`icon-btn${rightOpen ? " active" : ""}`}
            title="批注列表"
            onClick={() => setRightOpen((value) => !value)}
          >
            <HighlightIcon name="panel-right" />
          </button>
        </div>
      </header>

      <div className="main">
        {leftOpen ? (
          <aside className="sidebar left">
            <div className="sidebar-head">
              <span>工作区文件</span>
              <div className="sidebar-head-actions">
                <button
                  className="icon-btn"
                  title="打开工作区外文件"
                  onClick={openPathDialog}
                >
                  <HighlightIcon name="folder" />
                </button>
                <button className="icon-btn" title="刷新" onClick={refreshFiles}>
                  <HighlightIcon name="refresh" />
                </button>
              </div>
            </div>
            <div className="search-box">
              <HighlightIcon name="search" size={14} />
              <input
                value={fileFilter}
                onChange={(event) => setFileFilter(event.target.value)}
                placeholder="筛选文件…"
              />
            </div>
            <div className="file-list">
              {filesLoading ? (
                <div className="empty-hint">正在读取…</div>
              ) : filteredFiles.length === 0 ? (
                <div className="empty-hint">
                  工作区中没有可批注的文档
                  <br />
                  <span className="tiny">支持 .md / .txt / .pdf / .docx</span>
                </div>
              ) : (
                filteredFiles.map((file) => (
                  <button
                    key={file.path}
                    className={`file-item${doc?.info.path === file.path ? " active" : ""}`}
                    title={file.path}
                    onClick={() => void openDocument(file.path)}
                  >
                    <span className={`file-badge kind-${file.kind ?? "?"}`}>
                      {kindLabel(file.kind)}
                    </span>
                    <span className="file-name">{file.name}</span>
                    <span className="file-dir">{file.path.includes("/") ? compactPath(file.path, 34) : ""}</span>
                  </button>
                ))
              )}
            </div>
            <div className="sidebar-foot">
              {files.length} 篇文档 · 支持 MD/TXT/PDF/DOCX
            </div>
          </aside>
        ) : null}

        <section className="viewer">
          {refreshHint ? (
            <div className="doc-banner refresh-banner">
              <span>
                检测到 {refreshHint.paths.map((path) => compactPath(path, 40)).join("、")} 已更新，
                批注位置可能需要重新核对。
              </span>
              <button className="btn small" onClick={() => void refreshChanged()}>
                <HighlightIcon name="refresh" size={13} /> 刷新预览
              </button>
            </div>
          ) : null}
          {doc?.info.external ? (
            <div className="doc-banner external-banner">
              工作区外文件：{compactPath(doc.info.path, 80)}。插件只读预览；批注发送后由 Agent 修改原文件。
            </div>
          ) : null}
          {docLoading ? (
            <div className="viewer-state">
              <div className="spinner" />
              <div>正在打开文档…</div>
            </div>
          ) : docError ? (
            <div className="viewer-state error">
              <div>无法打开文档</div>
              <div className="tiny">{docError}</div>
              <button className="btn" onClick={() => setDocError(null)}>
                关闭
              </button>
            </div>
          ) : !doc ? (
            <div className="viewer-state">
              <div className="empty-icon">📄</div>
              <div className="empty-title">从左侧选择一篇文档开始</div>
              <div className="tiny">
                选中文字后点击「添加批注」，批注会随文档一起保存，最后统一发送给主 Agent。
              </div>
              {bridge.capabilities.message || bridge.capabilities.updateModelContext ? (
                <div className="capability ok">
                  <HighlightIcon name="check" size={14} />
                  {bridge.capabilities.message ? "支持直接发送到对话" : "支持填入对话上下文"}
                </div>
              ) : (
                <div className="capability warn">
                  当前宿主未提供发送能力，可使用「查看合并内容」手动复制。
                </div>
              )}
              <div className="empty-actions">
                {lastDocPath ? (
                  <>
                    <button
                      className="btn small"
                      onClick={() =>
                        void openDocument(lastDocPath, {
                          external: isAbsolutePath(lastDocPath),
                        })
                      }
                    >
                      <HighlightIcon name="file" size={14} /> 打开上次文档
                    </button>
                    <div className="tiny">{compactPath(lastDocPath, 64)}</div>
                  </>
                ) : null}
                <button className="btn small" onClick={openPathDialog}>
                  <HighlightIcon name="folder" size={14} /> 打开工作区外文件
                </button>
              </div>
            </div>
          ) : doc.kind === "text" ? (
            <>
              {doc.info.kind === "docx" || docWarnings.length > 0 ? (
                <div className={`doc-banner${docWarnings.length === 0 ? " external-banner" : ""}`}>
                  {doc.info.kind === "docx"
                    ? "DOCX 已转换为 Markdown 预览；批注按原文文本匹配定位，Agent 会在 Word 原文中核对。"
                    : ""}
                  {doc.info.kind === "docx" && docWarnings.length > 0 ? "；" : ""}
                  {docWarnings.join("；")}
                </div>
              ) : null}
              {doc.info.kind === "docx" || (doc.info.kind === "md" && viewMode === "rendered") ? (
                <div className="scroll-area" ref={viewerRef}>
                  <MarkdownView
                    source={doc.text}
                    annotations={renderAnnotations}
                    activeId={activeId}
                    onMarkClick={handleMarkClick}
                    containerRef={textRef}
                    numberById={numberById}
                    revision={docRevision}
                  />
                </div>
              ) : (
                <div className="scroll-area" ref={viewerRef}>
                  <TextView
                    source={doc.text}
                    annotations={renderAnnotations}
                    activeId={activeId}
                    onMarkClick={handleMarkClick}
                    containerRef={textRef}
                    monospace={doc.info.kind === "md" || viewMode === "source"}
                    numberById={numberById}
                    revision={docRevision}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              {docWarnings.length > 0 ? (
                <div className="doc-banner">{docWarnings.join("；")}</div>
              ) : null}
              <PdfViewer
                bytes={doc.bytes}
                bridge={bridge}
                annotations={renderAnnotations}
                activeId={activeId}
                zoom={pdfZoom}
                numberById={numberById}
                onMarkClick={handleMarkClick}
                onSelection={handlePdfSelection}
                onReady={setPdfPageCount}
                onError={handlePdfError}
                containerRef={viewerRef}
              />
            </>
          )}

          {selection && !composer ? (
            <div
              className="selection-add"
              style={{ top: selection.top, left: selection.left }}
              onMouseDown={(event) => event.preventDefault()}
            >
              <button className="btn primary small" onClick={openComposerForSelection}>
                <HighlightIcon name="plus" size={14} /> 添加批注
              </button>
            </div>
          ) : null}
        </section>

        {rightOpen ? (
          <aside className="sidebar right">
            <div className="sidebar-head">
              <span>
                批注列表 <span className="count-pill">{drafts.length}</span>
              </span>
              <div className="sidebar-head-actions">
                <button className="text-btn" onClick={openOverview}>
                  <HighlightIcon name="list" size={13} /> 总览
                </button>
                <label className="sent-toggle">
                  <input
                    type="checkbox"
                    checked={showSent}
                    onChange={(event) => setShowSent(event.target.checked)}
                  />
                  已发送
                </label>
              </div>
            </div>
            <div className="annotation-list">
              {drafts.length === 0 && (!showSent || sent.length === 0) ? (
                <div className="empty-hint">
                  还没有批注
                  <br />
                  <span className="tiny">在文档中选中文字，点击「添加批注」</span>
                </div>
              ) : null}
              {(showSent ? sortAnnotations([...drafts, ...sent]) : drafts).map((annotation) => (
                <div
                  key={annotation.id}
                  className={`annotation-card${annotation.id === activeId ? " active" : ""}${
                    annotation.status === "sent" ? " sent" : ""
                  }`}
                  onClick={() => scrollToAnnotation(annotation)}
                >
                  <div className="annotation-head">
                    <span className="annotation-number">
                      #{numberById.get(annotation.id) ?? "·"}
                    </span>
                    <span className="annotation-file" title={annotation.docPath}>
                      {compactPath(annotation.docPath, 32)}
                    </span>
                    <span className={`tag intent-${annotationIntent(annotation)}`}>
                      {intentLabel(annotationIntent(annotation))}
                    </span>
                    {annotation.status === "sent" ? (
                      <span className="tag sent">已发送</span>
                    ) : annotation.stale ? (
                      <span className="tag stale">位置待核对</span>
                    ) : null}
                  </div>
                  <div className="annotation-quote">{annotation.quote}</div>
                  <div className="annotation-comment">{annotation.comment}</div>
                  <div className="annotation-actions">
                    <button
                      className="text-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        setActiveId(annotation.id);
                      }}
                    >
                      定位
                    </button>
                    <button
                      className="text-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        openComposerForEdit(annotation);
                      }}
                    >
                      <HighlightIcon name="edit" size={13} /> 编辑
                    </button>
                    <button
                      className="text-btn danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteAnnotation(annotation);
                      }}
                    >
                      <HighlightIcon name="trash" size={13} /> 删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="sidebar-foot">
              {currentDocDrafts.length} 条在本文件 · {drafts.length} 条待发送
            </div>
          </aside>
        ) : null}
      </div>

      {navigatorOpen && navigatorItems.length > 0 ? (
        <div className="annotation-nav" role="dialog" aria-label="批注导航">
          <div className="annotation-nav-head">
            <span>
              批注导航 <span className="count-pill">{navigatorItems.length}</span>
              {navigatorScope === "all" ? <span className="tiny"> 全部文件</span> : null}
            </span>
            <span className="tiny">↑↓ 选择 · Enter 定位 · Esc 关闭</span>
          </div>
          <div className="annotation-nav-list" role="listbox" ref={navListRef}>
            {navigatorItems.map((annotation, index) => {
              const intent = annotationIntent(annotation);
              return (
                <button
                  key={annotation.id}
                  type="button"
                  role="option"
                  aria-selected={index === navIndex}
                  data-nav-index={index}
                  className={`annotation-nav-item${index === navIndex ? " active" : ""}`}
                  onMouseEnter={() => setNavIndex(index)}
                  onClick={() => {
                    setNavIndex(index);
                    void jumpToAnnotation(annotation);
                  }}
                >
                  <div className="annotation-nav-top">
                    <span className="annotation-number">
                      #{numberById.get(annotation.id) ?? "·"}
                    </span>
                    <span className={`tag intent-${intent}`}>{intentLabel(intent)}</span>
                    <span className="annotation-nav-pos">{positionLabel(annotation)}</span>
                    {navigatorScope === "all" ? (
                      <span className="annotation-nav-file" title={annotation.docPath}>
                        {compactPath(annotation.docPath, 26)}
                      </span>
                    ) : null}
                  </div>
                  <div className="annotation-nav-quote">{annotation.quote}</div>
                  <div className="annotation-nav-comment">{annotation.comment}</div>
                </button>
              );
            })}
          </div>
          <div className="annotation-nav-foot">
            <button
              className="text-btn"
              onClick={() => {
                setNavigatorOpen(false);
                openOverview();
              }}
            >
              <HighlightIcon name="list" size={13} /> 查看全部批注
            </button>
            <span className="tiny">
              {navIndex + 1} / {navigatorItems.length}
            </span>
          </div>
        </div>
      ) : null}

      <footer className="bottombar">
        <div className="bottombar-left">
          <button
            type="button"
            className={`draft-count${navigatorOpen ? " active" : ""}`}
            onClick={toggleNavigator}
            disabled={drafts.length === 0}
            title={drafts.length > 0 ? "查看批注（↑↓ 选择，Enter 定位）" : "暂无待发送批注"}
          >
            这 <strong>{drafts.length}</strong> 条批注
            <HighlightIcon name={navigatorOpen ? "chevron-down" : "chevron-up"} size={12} />
          </button>
          {drafts.length > 0 ? (
            <span className="tiny">
              {new Set(drafts.map((annotation) => annotation.docPath)).size} 个文件
            </span>
          ) : null}
        </div>
        <div className="bottombar-actions">
          <button className="btn" onClick={clearDrafts} disabled={drafts.length === 0 || sending}>
            清空
          </button>
          <button
            className="btn"
            onClick={() => setPreviewOpen(true)}
            disabled={drafts.length === 0 || sending}
          >
            <HighlightIcon name="eye" size={15} /> 查看合并内容
          </button>
          <button
            className="btn primary"
            onClick={handleSend}
            disabled={drafts.length === 0 || sending}
            title={bridge.capabilities.message ? "发送给主 Agent" : "填入对话上下文"}
          >
            {sending ? <span className="spinner small" /> : <HighlightIcon name="send" size={15} />}
            {sending ? "发送中…" : "批量发送"}
          </button>
        </div>
      </footer>

      {toast ? (
        <div className={`toast ${toast.kind}`}>
          <span>{toast.text}</span>
          {toast.action ? (
            <button
              className="toast-action"
              onClick={() => {
                toast.action?.onClick();
              }}
            >
              <HighlightIcon name="undo" size={13} /> {toast.action.label}
            </button>
          ) : null}
          <button className="toast-close" onClick={() => setToast(null)}>
            <HighlightIcon name="x" size={13} />
          </button>
        </div>
      ) : null}

      {overviewOpen ? (
        <div className="modal-backdrop" onClick={() => setOverviewOpen(false)}>
          <div className="modal overview" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>
                全部批注 <span className="count-pill">{annotations.length}</span>
              </span>
              <button className="icon-btn" onClick={() => setOverviewOpen(false)}>
                <HighlightIcon name="x" />
              </button>
            </div>
            <div className="overview-toolbar">
              <div className="segmented">
                <button
                  className={overviewFilter === "all" ? "active" : ""}
                  onClick={() => setOverviewFilter("all")}
                >
                  全部 {annotations.length}
                </button>
                <button
                  className={overviewFilter === "draft" ? "active" : ""}
                  onClick={() => setOverviewFilter("draft")}
                >
                  待发送 {drafts.length}
                </button>
                <button
                  className={overviewFilter === "sent" ? "active" : ""}
                  onClick={() => setOverviewFilter("sent")}
                >
                  已发送 {sent.length}
                </button>
              </div>
              <input
                className="overview-search"
                value={overviewQuery}
                onChange={(event) => setOverviewQuery(event.target.value)}
                placeholder="搜索原文、意见或文件…"
              />
              <button className="btn" onClick={copyAllAnnotations} disabled={annotations.length === 0}>
                <HighlightIcon name="copy" size={14} /> 复制全部
              </button>
            </div>
            <div className="overview-body">
              {overviewGroups.length === 0 ? (
                <div className="empty-hint">
                  {annotations.length === 0 ? "还没有批注" : "没有匹配的批注"}
                </div>
              ) : (
                overviewGroups.map(([file, items]) => (
                  <section className="overview-group" key={file}>
                    <div className="overview-group-head">
                      <span className="overview-file" title={file}>
                        {compactPath(file, 64)}
                      </span>
                      <span className="count-pill">{items.length}</span>
                    </div>
                    {items.map((annotation) => (
                      <div
                        className={`overview-item${annotation.id === activeId ? " active" : ""}`}
                        key={annotation.id}
                      >
                        <div className="overview-item-head">
                          <span className="annotation-number">
                            #{numberById.get(annotation.id) ?? "·"}
                          </span>
                          <span
                            className={`tag intent-${annotationIntent(annotation)}`}
                          >
                            {intentLabel(annotationIntent(annotation))}
                          </span>
                          <span
                            className={`tag ${
                              annotation.status === "sent"
                                ? "sent"
                                : annotation.stale
                                  ? "stale"
                                  : "draft"
                            }`}
                          >
                            {annotation.status === "sent"
                              ? "已发送"
                              : annotation.stale
                                ? "位置待核对"
                                : "待发送"}
                          </span>
                          <span className="overview-time">
                            {new Date(annotation.createdAt).toLocaleString("zh-CN", {
                              month: "2-digit",
                              day: "2-digit",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        <div className="overview-quote">{annotation.quote}</div>
                        <div className="overview-comment">{annotation.comment}</div>
                        <div className="overview-item-foot">
                          <span className="tiny">{positionLabel(annotation)}</span>
                          <div className="overview-actions">
                            <button
                              className="text-btn"
                              onClick={() => void jumpToAnnotation(annotation)}
                            >
                              定位
                            </button>
                            <button
                              className="text-btn"
                              onClick={() => {
                                setOverviewOpen(false);
                                openComposerForEdit(annotation);
                              }}
                            >
                              <HighlightIcon name="edit" size={13} /> 编辑
                            </button>
                            <button
                              className="text-btn danger"
                              onClick={() => deleteAnnotation(annotation)}
                            >
                              <HighlightIcon name="trash" size={13} /> 删除
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </section>
                ))
              )}
            </div>
            <div className="modal-foot">
              <span className="tiny">
                {drafts.length} 条待发送 · {sent.length} 条已发送
              </span>
              <button className="btn" onClick={() => setOverviewOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pathDialogOpen ? (
        <div className="modal-backdrop" onClick={() => setPathDialogOpen(false)}>
          <div className="modal small" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>打开工作区外的文件</span>
              <button className="icon-btn" onClick={() => setPathDialogOpen(false)}>
                <HighlightIcon name="x" />
              </button>
            </div>
            <div className="confirm-body">
              <div className="tiny">
                填写文件的绝对路径，支持 .md / .txt / .pdf / .docx。插件只读预览；批注发送后由
                Agent 修改原文件。
              </div>
              <div className="path-row">
                <input
                  autoFocus
                  className="path-input"
                  value={pathInput}
                  spellCheck={false}
                  placeholder="例如 D:/papers/report.docx"
                  onChange={(event) => setPathInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitExternalPath();
                    }
                  }}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={browseLoading || pathLoading}
                  onClick={() => void browseExternalFile()}
                  title="从电脑中选择文件"
                >
                  {browseLoading ? (
                    <span className="spinner small" />
                  ) : (
                    <HighlightIcon name="folder" size={14} />
                  )}
                  {browseLoading ? "等待选择…" : "浏览…"}
                </button>
              </div>
              {pathError ? <div className="path-error">{pathError}</div> : null}
            </div>
            <div className="modal-foot">
              <span className="tiny">仅用户主动打开；Agent 不能调用此入口</span>
              <div className="composer-actions">
                <button className="btn" onClick={() => setPathDialogOpen(false)}>
                  取消
                </button>
                <button
                  className="btn primary"
                  disabled={!pathInput.trim() || pathLoading}
                  onClick={() => void submitExternalPath()}
                >
                  {pathLoading ? <span className="spinner small" /> : null}
                  {pathLoading ? "打开中…" : "打开"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {inlineEditor && inlineAnnotation ? (
        <div
          className="inline-editor"
          style={{
            top: inlineEditor.top,
            left: inlineEditor.left,
            width: inlineEditor.width,
          }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="inline-editor-intents" role="group" aria-label="批注意图">
            {INTENT_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`intent-chip intent-${option.value}${
                  inlineEditor.intent === option.value ? " is-on" : ""
                }`}
                title={option.hint}
                aria-pressed={inlineEditor.intent === option.value}
                onClick={() =>
                  setInlineEditor((current) =>
                    current ? { ...current, intent: option.value } : current,
                  )
                }
              >
                {option.label}
              </button>
            ))}
            {inlineAnnotation.stale ? <span className="tag stale">位置待核对</span> : null}
            {inlineAnnotation.status === "sent" ? <span className="tag sent">已发送</span> : null}
          </div>
          <textarea
            autoFocus
            className="inline-editor-input"
            value={inlineEditor.value}
            placeholder={
              inlineEditor.intent === "delete"
                ? "可补充删除原因（可留空）"
                : inlineEditor.intent === "ask"
                  ? "写下你的疑问…"
                  : "修改建议…"
            }
            onChange={(event) =>
              setInlineEditor((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                saveInlineEditor();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setInlineEditor(null);
              }
            }}
          />
          <div className="inline-editor-foot">
            <button
              type="button"
              className="icon-btn inline-editor-delete"
              title="删除批注"
              onClick={deleteInlineEditor}
            >
              <HighlightIcon name="trash" size={15} />
            </button>
            <span className="inline-editor-pos">{positionLabel(inlineAnnotation)}</span>
            <div className="inline-editor-actions">
              <button className="btn small" onClick={() => setInlineEditor(null)}>
                取消
              </button>
              <button
                className="btn primary small"
                disabled={!inlineEditor.value.trim() && inlineEditor.intent !== "delete"}
                onClick={saveInlineEditor}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {composerElement}

      {previewOpen ? (
        <div className="modal-backdrop" onClick={() => setPreviewOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>将发送给主 Agent 的内容</span>
              <button className="icon-btn" onClick={() => setPreviewOpen(false)}>
                <HighlightIcon name="x" />
              </button>
            </div>
            <pre className="message-preview">{previewText}</pre>
            <div className="modal-foot">
              <span className="tiny">
                共 {drafts.length} 条批注 · {previewText.length} 字符
              </span>
              <div className="composer-actions">
                <button className="btn" onClick={copyPreview}>
                  <HighlightIcon name="copy" size={14} /> 复制
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    setPreviewOpen(false);
                    handleSend();
                  }}
                  disabled={sending}
                >
                  <HighlightIcon name="send" size={14} /> 确认发送
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {confirmState ? (
        <div className="modal-backdrop" onClick={() => setConfirmState(null)}>
          <div className="modal small" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <span>{confirmState.title}</span>
              <button className="icon-btn" onClick={() => setConfirmState(null)}>
                <HighlightIcon name="x" />
              </button>
            </div>
            <div className="confirm-body">{confirmState.body}</div>
            <div className="modal-foot">
              <span />
              <div className="composer-actions">
                <button className="btn" onClick={() => setConfirmState(null)}>
                  取消
                </button>
                <button
                  className={`btn${confirmState.danger ? " danger" : " primary"}`}
                  onClick={confirmState.onConfirm}
                >
                  {confirmState.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
