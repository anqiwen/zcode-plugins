export type DocKind = "md" | "txt" | "pdf" | "docx";

export interface DocumentInfo {
  /** Path relative to the workspace root, using forward slashes. */
  path: string;
  name: string;
  ext: string;
  kind: DocKind;
  size: number;
  mtimeMs: number;
  /** sha256 of the file bytes; used to detect stale anchors. */
  hash: string;
  /** True when the file is served as binary (pdf). */
  binary: boolean;
  /** True when the preview text was converted from another format (docx). */
  converted?: boolean;
  /** True when the file was explicitly opened from outside the workspace. */
  external?: boolean;
  chunkCount: number;
  chunkBytes: number;
  /** Number of 1 MiB chunks for the raw file bytes (docx original preview). */
  byteChunkCount?: number;
  /** Opaque token used to read the file through ui://document-reviewer/file/<token>/<i>. */
  token: string;
  /** Non-fatal warnings, e.g. truncated preview. */
  warnings?: string[];
}

export interface TextDocument extends DocumentInfo {
  kind: "md" | "txt";
  /** Full text (UTF-8). Absent when the file is too large and served in chunks. */
  text?: string;
}

export interface WorkspaceInfo {
  root: string;
  name: string;
  workspaceKey: string;
  annotationsPath: string;
}

export type AnchorKind = "text" | "pdf";

export interface TextAnchor {
  kind: "text";
  /** Character offsets into the document source (0-based, end exclusive). */
  start: number;
  end: number;
  /** 1-based inclusive line numbers. */
  startLine: number;
  endLine: number;
  /** Up to 60 chars before/after the quote, used for re-anchoring. */
  prefix: string;
  suffix: string;
  /** 0-based occurrence of the quote in the preview text (docx only). */
  occurrence?: number;
  /** 1-based paragraph index in the preview text (docx only). */
  paragraph?: number;
}

export interface PdfRect {
  /** Normalized to the page box: 0..1, origin top-left. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfAnchor {
  kind: "pdf";
  page: number; // 1-based
  /** Index of the first/last text item on the page. */
  startItem: number;
  endItem: number;
  /** Character offset inside the first/last text item. */
  startOffset: number;
  endOffset: number;
  prefix: string;
  suffix: string;
  /** Highlight rectangles in page-normalized coordinates. */
  rects: PdfRect[];
}

export type Anchor = TextAnchor | PdfAnchor;

export type AnnotationStatus = "draft" | "sent";

export type AnnotationIntent = "edit" | "delete" | "ask";

export interface Annotation {
  id: string;
  docPath: string;
  docKind: DocKind;
  docHash: string;
  quote: string;
  comment: string;
  anchor: Anchor;
  createdAt: string;
  updatedAt: string;
  status: AnnotationStatus;
  /** What the Agent should do with this annotation. Defaults to "edit". */
  intent?: AnnotationIntent;
  /** Set when the document changed after the annotation was created. */
  stale?: boolean;
  /** Batch id assigned when the annotations were sent. */
  batchId?: string;
  sentAt?: string;
}

export interface DraftStore {
  version: 1;
  workspaceKey: string;
  annotations: Annotation[];
  lastDocPath?: string;
  updatedAt: string;
}

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type Result<T> = Ok<T> | Err;

export const SUPPORTED_EXTENSIONS = [".md", ".markdown", ".txt", ".pdf", ".docx"] as const;

export const DOC_KIND_BY_EXT: Record<string, DocKind> = {
  ".md": "md",
  ".markdown": "md",
  ".txt": "txt",
  ".pdf": "pdf",
  ".docx": "docx",
};
