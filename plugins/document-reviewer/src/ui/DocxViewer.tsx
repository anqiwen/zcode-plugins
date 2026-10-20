import React, { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import type { RenderAnnotation } from "./highlight.js";
import { normalizeWhitespace } from "./text.js";
import { PinOverlay } from "./pins.js";

export interface DocxViewerProps {
  bytes: Uint8Array;
  annotations: RenderAnnotation[];
  activeId: string | null;
  onMarkClick: (id: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  numberById: Map<string, number>;
  revision?: string;
  onError?: (message: string) => void;
}

interface RenderedTextIndex {
  text: string;
  nodes: Text[];
  offsets: number[];
}

function isInsideHighlight(node: Node, root: HTMLElement): boolean {
  let element = node.parentElement;
  while (element && element !== root) {
    if (element.tagName === "MARK" && element.classList.contains("hl")) return true;
    element = element.parentElement;
  }
  return false;
}

function buildRenderedIndex(root: HTMLElement): RenderedTextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (isInsideHighlight(node, root)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      const tag = parent?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const chars: string[] = [];
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let previousSpace = false;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const value = node.nodeValue ?? "";
    for (let i = 0; i < value.length; i += 1) {
      const ch = value[i];
      if (/\s/.test(ch)) {
        if (!previousSpace && chars.length > 0) {
          chars.push(" ");
          nodes.push(node);
          offsets.push(i);
        }
        previousSpace = true;
        continue;
      }
      chars.push(ch);
      nodes.push(node);
      offsets.push(i);
      previousSpace = false;
    }
    node = walker.nextNode() as Text | null;
  }
  while (chars.length > 0 && chars[chars.length - 1] === " ") {
    chars.pop();
    nodes.pop();
    offsets.pop();
  }
  return { text: chars.join(""), nodes, offsets };
}

function findMatch(
  index: RenderedTextIndex,
  annotation: RenderAnnotation,
): { start: number; end: number } | null {
  if (annotation.anchor.kind !== "text") return null;
  const needle = normalizeWhitespace(annotation.quote);
  if (!needle) return null;

  const occurrences: number[] = [];
  let from = 0;
  while (occurrences.length < 200) {
    const at = index.text.indexOf(needle, from);
    if (at < 0) break;
    occurrences.push(at);
    from = at + Math.max(1, needle.length);
  }
  if (occurrences.length === 0) return null;

  const anchor = annotation.anchor;
  const preferred = anchor.occurrence;
  if (typeof preferred === "number" && preferred >= 0 && preferred < occurrences.length) {
    const at = occurrences[preferred];
    return { start: at, end: at + needle.length };
  }

  const prefix = normalizeWhitespace(anchor.prefix);
  const suffix = normalizeWhitespace(anchor.suffix);
  let best = occurrences[0];
  let bestScore = -1;
  for (const at of occurrences) {
    let score = 0;
    if (prefix && index.text.slice(Math.max(0, at - prefix.length), at).endsWith(prefix)) {
      score += 2;
    }
    if (
      suffix &&
      index.text
        .slice(at + needle.length, at + needle.length + suffix.length)
        .startsWith(suffix)
    ) {
      score += 2;
    }
    if (score > bestScore) {
      best = at;
      bestScore = score;
    }
    if (score >= 4) break;
  }
  return { start: best, end: best + needle.length };
}

function clearHighlights(root: HTMLElement): void {
  const marks = Array.from(
    root.querySelectorAll<HTMLElement>("mark.hl[data-annotation-id]"),
  );
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
  }
  if (marks.length > 0) root.normalize();
}

function wrapNodeRange(
  node: Text,
  from: number,
  to: number,
  annotation: RenderAnnotation,
  activeId: string | null,
): void {
  const text = node.nodeValue ?? "";
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.max(start, Math.min(to, text.length));
  if (end <= start) return;

  const after = node.splitText(end);
  const middle = start > 0 ? node.splitText(start) : node;
  void after;

  const mark = document.createElement("mark");
  mark.className = [
    "hl",
    annotation.pending
      ? "hl-pending"
      : annotation.status === "sent"
        ? "hl-sent"
        : "hl-draft",
    annotation.id === activeId ? "hl-active" : "",
    annotation.stale ? "hl-stale" : "",
  ]
    .filter(Boolean)
    .join(" ");
  mark.dataset.annotationId = annotation.id;
  mark.title = annotation.pending ? "待保存的批注" : annotation.comment.slice(0, 200);
  middle.parentNode?.insertBefore(mark, middle);
  mark.appendChild(middle);
}

function applyHighlights(
  root: HTMLElement,
  annotations: RenderAnnotation[],
  activeId: string | null,
): void {
  clearHighlights(root);
  for (const annotation of annotations) {
    if (annotation.anchor.kind !== "text") continue;
    const index = buildRenderedIndex(root);
    const match = findMatch(index, annotation);
    if (!match) continue;

    const ranges = new Map<Text, { start: number; end: number }>();
    for (let i = match.start; i < match.end; i += 1) {
      const node = index.nodes[i];
      const offset = index.offsets[i];
      if (!node) continue;
      const existing = ranges.get(node);
      if (existing) {
        existing.start = Math.min(existing.start, offset);
        existing.end = Math.max(existing.end, offset + 1);
      } else {
        ranges.set(node, { start: offset, end: offset + 1 });
      }
    }
    for (const [node, range] of ranges) {
      wrapNodeRange(node, range.start, range.end, annotation, activeId);
    }
  }
}

export const DocxViewer = React.memo(function DocxViewer({
  bytes,
  annotations,
  activeId,
  onMarkClick,
  containerRef,
  numberById,
  revision,
  onError,
}: DocxViewerProps) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef(onError);
  const [renderRevision, setRenderRevision] = useState(0);
  const [highlightRevision, setHighlightRevision] = useState(0);

  useEffect(() => {
    errorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let cancelled = false;
    body.innerHTML = "";
    setRenderRevision(0);
    const data = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    void renderAsync(data, body, styleRef.current ?? undefined, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      useBase64URL: true,
    })
      .then(() => {
        if (!cancelled) setRenderRevision((value) => value + 1);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          errorRef.current?.(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || renderRevision === 0) return;
    applyHighlights(body, annotations, activeId);
    setHighlightRevision((value) => value + 1);
  }, [renderRevision, annotations, activeId]);

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = (event.target as HTMLElement | null)?.closest?.(
      "mark.hl[data-annotation-id]",
    ) as HTMLElement | null;
    const id = target?.dataset.annotationId;
    if (!id) return;
    event.stopPropagation();
    onMarkClick(id);
  };

  return (
    <div className="docx-view" ref={containerRef} onClick={handleClick}>
      <div className="docx-pages" ref={bodyRef} />
      <div className="docx-style" ref={styleRef} />
      <PinOverlay
        containerRef={containerRef}
        annotations={annotations}
        activeId={activeId}
        numberById={numberById}
        onPinClick={onMarkClick}
        revision={`${renderRevision}-${highlightRevision}-${revision ?? ""}`}
      />
    </div>
  );
});
