import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PDFWorker,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import type { Annotation, PdfRect } from "../shared/types.js";
import type { Bridge } from "./bridge.js";
import type { RenderAnnotation } from "./highlight.js";

const ASSET_PREFIX = "ui://document-reviewer/assets/";

export interface PdfSelectionPart {
  page: number;
  startItem: number;
  startOffset: number;
  endItem: number;
  endOffset: number;
  quote: string;
  prefix: string;
  suffix: string;
  rects: PdfRect[];
  /** Character offsets inside the page's concatenated text, for display. */
  pageTextStart: number;
  pageTextEnd: number;
}

class AssetCMapReaderFactory {
  private bridge: Bridge;
  constructor(options: { baseUrl?: string | null; isCompressed?: boolean }, bridge: Bridge) {
    this.bridge = bridge;
  }
  async fetch({ name }: { name: string }) {
    return {
      cMapData: await this.bridge.readAsset(`pdfjs/cmaps/${name}.bcmap`),
      isCompressed: true,
    };
  }
}

class AssetStandardFontDataFactory {
  private bridge: Bridge;
  constructor(_options: unknown, bridge: Bridge) {
    this.bridge = bridge;
  }
  async fetch({ filename }: { filename: string }) {
    return this.bridge.readAsset(`pdfjs/standard_fonts/${filename}`);
  }
}

class AssetWasmFactory {
  private bridge: Bridge;
  constructor(_options: unknown, bridge: Bridge) {
    this.bridge = bridge;
  }
  async fetch({ filename }: { filename: string }) {
    return this.bridge.readAsset(`pdfjs/wasm/${filename}`);
  }
}

interface PageRegistryEntry {
  pageEl: HTMLDivElement;
  textLayer: TextLayer;
}

export interface PdfViewerHandle {
  scrollToAnnotation: (annotation: Annotation) => void;
}

interface HighlightBox {
  id: string;
  rects: PdfRect[];
  active: boolean;
  draft: boolean;
  sent: boolean;
  stale: boolean;
  pending: boolean;
  comment: string;
}

function normalizeRects(rects: DOMRectList, pageRect: DOMRect): PdfRect[] {
  const out: PdfRect[] = [];
  for (let i = 0; i < rects.length; i += 1) {
    const rect = rects[i];
    if (rect.width < 0.5 || rect.height < 0.5) continue;
    out.push({
      x: (rect.left - pageRect.left) / pageRect.width,
      y: (rect.top - pageRect.top) / pageRect.height,
      w: rect.width / pageRect.width,
      h: rect.height / pageRect.height,
    });
    if (out.length >= 400) break;
  }
  return out;
}

function textOffsetWithin(element: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  try {
    range.setEnd(container, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

function setRangeBoundary(
  range: Range,
  span: HTMLElement,
  offset: number,
  side: "start" | "end",
): void {
  let remaining = Math.max(0, offset);
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let last: Text | null = null;
  while (node) {
    const text = node as Text;
    if (remaining <= text.length) {
      if (side === "start") range.setStart(text, remaining);
      else range.setEnd(text, remaining);
      return;
    }
    remaining -= text.length;
    last = text;
    node = walker.nextNode();
  }
  if (last) {
    if (side === "start") range.setStart(last, last.length);
    else range.setEnd(last, last.length);
  } else {
    if (side === "start") range.setStart(span, 0);
    else range.setEnd(span, 0);
  }
}

function locateInPage(
  spans: HTMLElement[],
  node: Node,
  offset: number,
): { item: number; offset: number } | null {
  const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  let span: HTMLElement | null = null;
  for (const candidate of spans) {
    if (candidate === element || candidate.contains(element as Node)) {
      span = candidate;
      break;
    }
  }
  if (span) {
    const item = spans.indexOf(span);
    return { item, offset: textOffsetWithin(span, node, offset) };
  }
  return null;
}

export interface PdfSelectionResult {
  parts: PdfSelectionPart[];
  rawQuote: string;
}

export function resolvePdfSelection(
  root: HTMLElement,
  registry: Map<number, PageRegistryEntry>,
): PdfSelectionResult | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const pages = [...registry.entries()].sort((a, b) => a[0] - b[0]);
  const parts: PdfSelectionPart[] = [];
  let rawQuote = "";

  for (const [pageNumber, entry] of pages) {
    if (!range.intersectsNode(entry.pageEl)) continue;
    const spans = entry.textLayer.textDivs.filter(
      (span): span is HTMLElement => span instanceof HTMLElement && span.textContent !== "",
    );
    if (spans.length === 0) continue;

    const pageRange = document.createRange();
    if (entry.pageEl.contains(range.startContainer)) {
      pageRange.setStart(range.startContainer, range.startOffset);
    } else {
      pageRange.setStartBefore(spans[0]);
    }
    if (entry.pageEl.contains(range.endContainer)) {
      pageRange.setEnd(range.endContainer, range.endOffset);
    } else {
      pageRange.setEndAfter(spans[spans.length - 1]);
    }

    const quote = pageRange.toString().replace(/\s+/g, " ").trim();
    if (!quote) continue;

    const startPos =
      locateInPage(spans, pageRange.startContainer, pageRange.startOffset) ?? {
        item: 0,
        offset: 0,
      };
    const endPos =
      locateInPage(spans, pageRange.endContainer, pageRange.endOffset) ?? {
        item: spans.length - 1,
        offset: spans[spans.length - 1]?.textContent?.length ?? 0,
      };

    const pageRect = entry.pageEl.getBoundingClientRect();
    const rects = normalizeRects(pageRange.getClientRects(), pageRect);
    const pageText = spans.map((span) => span.textContent ?? "").join("");
    const offsetOfItem = (item: number, offset: number) => {
      let total = 0;
      for (let i = 0; i < item && i < spans.length; i += 1) total += spans[i].textContent?.length ?? 0;
      return total + offset;
    };

    parts.push({
      page: pageNumber,
      startItem: startPos.item,
      startOffset: startPos.offset,
      endItem: endPos.item,
      endOffset: endPos.offset,
      quote,
      prefix: "",
      suffix: "",
      rects,
      pageTextStart: offsetOfItem(startPos.item, startPos.offset),
      pageTextEnd: offsetOfItem(endPos.item, endPos.offset),
    });
    rawQuote += (rawQuote ? " " : "") + quote;
  }

  if (parts.length === 0) return null;
  return { parts, rawQuote };
}

interface PdfPageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
  annotations: RenderAnnotation[];
  activeId: string | null;
  scrollTargetId: string | null;
  numberById: Map<string, number>;
  onMarkClick: (id: string) => void;
  registerPage: (pageNumber: number, entry: PageRegistryEntry) => void;
  unregisterPage: (pageNumber: number) => void;
}

const PdfPage = React.memo(function PdfPage({
  doc,
  pageNumber,
  scale,
  width,
  height,
  annotations,
  activeId,
  scrollTargetId,
  numberById,
  onMarkClick,
  registerPage,
  unregisterPage,
}: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<TextLayer | null>(null);
  const [visible, setVisible] = useState(false);
  const [version, setVersion] = useState(0);
  const [rects, setRects] = useState<HighlightBox[]>([]);

  useEffect(() => {
    const element = pageRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting);
      },
      { root: null, rootMargin: "600px 0px", threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | null = null;
    const element = pageRef.current;
    const canvas = canvasRef.current;
    const textContainer = textRef.current;
    if (!element || !canvas || !textContainer) return;

    (async () => {
      const page: PDFPageProxy = await doc.getPage(pageNumber);
      if (cancelled) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      const output = page.getViewport({ scale: scale * dpr });
      canvas.width = Math.max(1, Math.floor(output.width));
      canvas.height = Math.max(1, Math.floor(output.height));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      renderTask = page.render({ canvasContext: ctx, viewport: output, canvas });
      await renderTask.promise;
      if (cancelled) return;

      textContainer.replaceChildren();
      textContainer.style.setProperty("--total-scale-factor", String(scale));
      textContainer.style.setProperty("--scale-round-x", "1px");
      textContainer.style.setProperty("--scale-round-y", "1px");
      const textContent = await page.getTextContent();
      if (cancelled) return;
      const layer = new TextLayer({
        textContentSource: textContent,
        container: textContainer,
        viewport,
      });
      await layer.render();
      if (cancelled) return;
      layerRef.current = layer;
      registerPage(pageNumber, { pageEl: element, textLayer: layer });
      setVersion((value) => value + 1);
    })().catch((error: any) => {
      if (error?.name !== "RenderingCancelledException") {
        console.warn(`[pdf] page ${pageNumber} render failed`, error);
      }
    });

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        /* ignore */
      }
    };
  }, [visible, scale, pageNumber, doc, registerPage]);

  useEffect(() => {
    return () => {
      unregisterPage(pageNumber);
      layerRef.current = null;
    };
  }, [pageNumber, unregisterPage]);

  useEffect(() => {
    const element = pageRef.current;
    const layer = layerRef.current;
    if (!element || !layer) {
      setRects([]);
      return;
    }
    const pageRect = element.getBoundingClientRect();
    const spans = layer.textDivs.filter(
      (span): span is HTMLElement =>
        span instanceof HTMLElement && (span.textContent?.length ?? 0) > 0,
    );
    const next: HighlightBox[] = [];
    for (const annotation of annotations) {
      if (annotation.anchor.kind !== "pdf" || annotation.anchor.page !== pageNumber) continue;
      const startSpan = spans[annotation.anchor.startItem];
      const endSpan = spans[annotation.anchor.endItem];
      if (!startSpan || !endSpan) continue;
      const range = document.createRange();
      try {
        setRangeBoundary(range, startSpan, annotation.anchor.startOffset, "start");
        setRangeBoundary(range, endSpan, annotation.anchor.endOffset, "end");
      } catch {
        continue;
      }
      const boxes = normalizeRects(range.getClientRects(), pageRect);
      if (boxes.length === 0) continue;
      next.push({
        id: annotation.id,
        rects: boxes,
        active: annotation.id === activeId,
        draft: annotation.status === "draft",
        sent: annotation.status === "sent",
        stale: Boolean(annotation.stale),
        pending: Boolean(annotation.pending),
        comment: annotation.comment,
      });
    }
    setRects(next);
  }, [annotations, activeId, pageNumber, version, scale]);

  useEffect(() => {
    if (!scrollTargetId) return;
    const hit = annotations.find((annotation) => annotation.id === scrollTargetId);
    if (!hit || hit.anchor.kind !== "pdf" || hit.anchor.page !== pageNumber) return;
    const element = pageRef.current;
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [scrollTargetId, annotations, pageNumber]);

  return (
    <div
      className="pdf-page"
      data-page={pageNumber}
      ref={pageRef}
      style={{
        width: `${width * scale}px`,
        height: `${height * scale}px`,
      }}
    >
      <canvas ref={canvasRef} className="pdf-canvas" />
      <div className="textLayer" ref={textRef} />
      {rects.map((box) => {
        const lastRect = box.rects[box.rects.length - 1];
        const number = numberById.get(box.id);
        return (
          <React.Fragment key={box.id}>
            {box.rects.map((rect, index) => (
              <div
                key={`${box.id}-${index}`}
                className={[
                  "pdf-hl",
                  box.pending
                    ? "pdf-hl-pending"
                    : box.draft
                      ? "pdf-hl-draft"
                      : "pdf-hl-sent",
                  box.active ? "pdf-hl-active" : "",
                  box.stale ? "pdf-hl-stale" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-annotation-id={box.id}
                title={box.pending ? "待保存的批注" : box.comment.slice(0, 200)}
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                }}
                onClick={
                  box.pending
                    ? undefined
                    : (event) => {
                        event.stopPropagation();
                        onMarkClick(box.id);
                      }
                }
              />
            ))}
            {!box.pending && lastRect ? (
              <button
                type="button"
                className={[
                  "pdf-pin",
                  box.active ? "active" : "",
                  box.sent ? "sent" : "",
                  box.stale ? "stale" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-annotation-id={box.id}
                style={{ top: `${(lastRect.y + lastRect.h) * 100}%` }}
                title={box.stale ? `批注 ${number ?? "·"}（位置待核对）` : `批注 ${number ?? "·"}`}
                aria-label={`批注 ${number ?? "·"}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  onMarkClick(box.id);
                }}
              >
                {number ?? "·"}
              </button>
            ) : null}
          </React.Fragment>
        );
      })}
      <div className="pdf-page-number">{pageNumber}</div>
    </div>
  );
});

export interface PdfViewerProps {
  bytes: Uint8Array;
  bridge: Bridge;
  annotations: RenderAnnotation[];
  activeId: string | null;
  zoom: number;
  numberById: Map<string, number>;
  onMarkClick: (id: string) => void;
  onSelection: (selection: PdfSelectionResult | null) => void;
  onReady: (pageCount: number) => void;
  onError: (message: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function PdfViewer({
  bytes,
  bridge,
  annotations,
  activeId,
  zoom,
  numberById,
  onMarkClick,
  onSelection,
  onReady,
  onError,
  containerRef,
}: PdfViewerProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageSizes, setPageSizes] = useState<Array<{ width: number; height: number }>>([]);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(null);
  const registry = useRef(new Map<number, PageRegistryEntry>());
  const workerRef = useRef<PDFWorker | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setContainerWidth(element.clientWidth);
    return () => observer.disconnect();
  }, [containerRef, doc]);

  useEffect(() => {
    let cancelled = false;
    const registryMap = registry.current;
    (async () => {
      try {
        const workerText = await bridge.readTextAsset("pdf-worker.js");
        const blobUrl = URL.createObjectURL(
          new Blob([workerText], { type: "text/javascript" }),
        );
        blobUrlRef.current = blobUrl;
        const worker = new Worker(blobUrl, { type: "module" });
        const pdfWorker = PDFWorker.create({ port: worker });
        workerRef.current = pdfWorker;
        const loading = getDocument({
          data: bytes.slice(),
          worker: pdfWorker,
          isEvalSupported: false,
          useWorkerFetch: false,
          cMapPacked: true,
          verbosity: 0,
          CMapReaderFactory: class extends AssetCMapReaderFactory {
            constructor(options: { baseUrl?: string | null; isCompressed?: boolean }) {
              super(options, bridge);
            }
          } as any,
          StandardFontDataFactory: class extends AssetStandardFontDataFactory {
            constructor(options: unknown) {
              super(options, bridge);
            }
          } as any,
          WasmFactory: class extends AssetWasmFactory {
            constructor(options: unknown) {
              super(options, bridge);
            }
          } as any,
        });
        const document = await loading.promise;
        if (cancelled) {
          await document.destroy();
          return;
        }
        const sizes: Array<{ width: number; height: number }> = [];
        for (let i = 1; i <= document.numPages; i += 1) {
          const page = await document.getPage(i);
          const viewport = page.getViewport({ scale: 1 });
          sizes.push({ width: viewport.width, height: viewport.height });
        }
        if (cancelled) return;
        setDoc(document);
        setPageSizes(sizes);
        onReadyRef.current(document.numPages);
      } catch (error: any) {
        console.error("[document-reviewer] pdf load failed", error);
        if (!cancelled) onErrorRef.current(error?.stack || error?.message || String(error));
      }
    })();

    return () => {
      cancelled = true;
      registryMap.clear();
      try {
        workerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      workerRef.current = null;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [bytes, bridge]);

  const maxWidth = useMemo(
    () => pageSizes.reduce((max, size) => Math.max(max, size.width), 0),
    [pageSizes],
  );
  const baseScale = containerWidth > 0 && maxWidth > 0
    ? Math.min(3, Math.max(0.2, (containerWidth - 40) / maxWidth))
    : 1;
  const scale = baseScale * zoom;

  const registerPage = useCallback((pageNumber: number, entry: PageRegistryEntry) => {
    registry.current.set(pageNumber, entry);
  }, []);
  const unregisterPage = useCallback((pageNumber: number) => {
    registry.current.delete(pageNumber);
  }, []);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const handle = () => {
      const result = resolvePdfSelection(element, registry.current);
      onSelection(result);
    };
    const timer = { id: 0 as number };
    const schedule = () => {
      window.clearTimeout(timer.id);
      timer.id = window.setTimeout(handle, 120);
    };
    element.addEventListener("mouseup", schedule);
    element.addEventListener("keyup", schedule);
    return () => {
      element.removeEventListener("mouseup", schedule);
      element.removeEventListener("keyup", schedule);
      window.clearTimeout(timer.id);
    };
  }, [containerRef, onSelection, doc]);

  useEffect(() => {
    setScrollTargetId(activeId);
  }, [activeId]);

  if (!doc) {
    return <div className="pdf-loading">正在加载 PDF…</div>;
  }

  return (
    <div className="pdf-scroll" ref={containerRef}>
      <div className="pdf-pages">
        {pageSizes.map((size, index) => (
          <PdfPage
            key={index + 1}
            doc={doc}
            pageNumber={index + 1}
            scale={scale}
            width={size.width}
            height={size.height}
            annotations={annotations}
            activeId={activeId}
            scrollTargetId={scrollTargetId}
            numberById={numberById}
            onMarkClick={onMarkClick}
            registerPage={registerPage}
            unregisterPage={unregisterPage}
          />
        ))}
      </div>
    </div>
  );
}
