import type { Annotation, TextAnchor } from "../shared/types.js";

export function buildLineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  }
  return offsets;
}

export function lineOf(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid] <= position) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export function makeTextAnchor(text: string, start: number, end: number): TextAnchor {
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

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Re-locates a quote after the document changed. Prefers the stored offsets,
 * then a prefix/suffix match, then a unique full-text search.
 */
export function relocateTextAnchor(
  text: string,
  anchor: TextAnchor,
  quote: string,
): { anchor: TextAnchor; exact: boolean } | null {
  const slice = text.slice(anchor.start, anchor.end);
  if (normalizeWhitespace(slice) === normalizeWhitespace(quote)) {
    return { anchor, exact: true };
  }

  const candidates: Array<{ start: number; end: number }> = [];
  const near = Math.max(0, anchor.start - 500);
  const windowEnd = Math.min(text.length, anchor.end + 500);
  const window = text.slice(near, windowEnd);
  const needle = quote.length > 2000 ? quote.slice(0, 2000) : quote;
  let from = 0;
  while (candidates.length < 20) {
    const at = window.indexOf(needle, from);
    if (at < 0) break;
    candidates.push({ start: near + at, end: near + at + needle.length });
    from = at + Math.max(1, needle.length);
  }

  if (candidates.length === 0) {
    const whole = text.indexOf(needle);
    if (whole >= 0 && text.indexOf(needle, whole + 1) < 0) {
      return { anchor: makeTextAnchor(text, whole, whole + needle.length), exact: false };
    }
    return null;
  }

  if (candidates.length > 1 && anchor.prefix) {
    const withPrefix = candidates.find((candidate) =>
      text.slice(Math.max(0, candidate.start - anchor.prefix.length), candidate.start) ===
      anchor.prefix,
    );
    if (withPrefix) {
      return {
        anchor: makeTextAnchor(text, withPrefix.start, withPrefix.end),
        exact: false,
      };
    }
  }

  const closest = candidates.reduce((best, candidate) =>
    Math.abs(candidate.start - anchor.start) < Math.abs(best.start - anchor.start)
      ? candidate
      : best,
  );
  return { anchor: makeTextAnchor(text, closest.start, closest.end), exact: false };
}

export interface DomTextSelection {
  start: number;
  end: number;
  /** Visible text from the selection, whitespace-collapsed. */
  quote: string;
  sourceQuote: string;
}

function closestSourceElement(node: Node | null, root: HTMLElement): HTMLElement | null {
  let element: HTMLElement | null =
    node && node.nodeType === Node.TEXT_NODE
      ? (node.parentElement as HTMLElement | null)
      : (node as HTMLElement | null);
  while (element && element !== root) {
    if (element.dataset && element.dataset.s !== undefined) return element;
    element = element.parentElement;
  }
  return null;
}

function offsetWithin(element: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  try {
    range.setEnd(container, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/**
 * Resolves the current DOM selection to source offsets using data-s/data-e
 * markers emitted by the text and markdown views.
 */
export function resolveDomSelection(
  root: HTMLElement,
  source: string,
  options: { quoteFromSelection: boolean },
): DomTextSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const startEl = closestSourceElement(range.startContainer, root);
  const endEl = closestSourceElement(range.endContainer, root);
  if (!startEl || !endEl) return null;

  const pageStart = Number(startEl.dataset.s);
  const pageEnd = Number(endEl.dataset.s);
  if (!Number.isFinite(pageStart) || !Number.isFinite(pageEnd)) return null;

  let start = pageStart + offsetWithin(startEl, range.startContainer, range.startOffset);
  let end = pageEnd + offsetWithin(endEl, range.endContainer, range.endOffset);
  if (end < start) [start, end] = [end, start];

  start = Math.max(0, Math.min(start, source.length));
  end = Math.max(0, Math.min(end, source.length));
  if (end <= start) return null;

  let raw = source.slice(start, end);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  if (leading > 0) start += leading;
  if (trailing > 0) end -= trailing;
  if (end <= start) return null;
  raw = source.slice(start, end);

  const visible = options.quoteFromSelection
    ? selection.toString()
    : raw;

  return {
    start,
    end,
    quote: normalizeWhitespace(visible) || normalizeWhitespace(raw),
    sourceQuote: raw,
  };
}

export function annotationsForRange(
  annotations: Annotation[],
  start: number,
  end: number,
): Annotation[] {
  return annotations.filter(
    (annotation) =>
      annotation.anchor.kind === "text" &&
      annotation.anchor.start < end &&
      annotation.anchor.end > start,
  );
}

interface NormalizedTextIndex {
  text: string;
  starts: number[];
  ends: number[];
}

let cachedNormalizedSource = "";
let cachedNormalizedIndex: NormalizedTextIndex | null = null;

function normalizedTextIndex(source: string): NormalizedTextIndex {
  if (cachedNormalizedIndex && cachedNormalizedSource === source) {
    return cachedNormalizedIndex;
  }
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let previousSpace = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      if (!previousSpace && chars.length > 0) {
        chars.push(" ");
        starts.push(i);
        ends.push(i + 1);
      }
      previousSpace = true;
      continue;
    }
    chars.push(ch);
    starts.push(i);
    ends.push(i + 1);
    previousSpace = false;
  }
  while (chars.length > 0 && chars[chars.length - 1] === " ") {
    chars.pop();
    starts.pop();
    ends.pop();
  }
  cachedNormalizedSource = source;
  cachedNormalizedIndex = { text: chars.join(""), starts, ends };
  return cachedNormalizedIndex;
}

function selectionSideText(
  root: HTMLElement,
  range: Range,
  side: "before" | "after",
): string {
  try {
    const probe = document.createRange();
    probe.selectNodeContents(root);
    if (side === "before") probe.setEnd(range.startContainer, range.startOffset);
    else probe.setStart(range.endContainer, range.endOffset);
    const text = normalizeWhitespace(probe.toString());
    return side === "before" ? text.slice(-80) : text.slice(0, 80);
  } catch {
    return "";
  }
}

/**
 * Resolves a selection made inside the docx-preview DOM. The rendered DOCX has
 * no source offsets, so the visible quote is matched against the converted
 * Markdown text (the canonical anchor source), using nearby context when the
 * quote occurs more than once.
 */
export function resolveDocxDomSelection(
  root: HTMLElement,
  source: string,
): DomTextSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const quote = normalizeWhitespace(selection.toString());
  if (!quote) return null;

  const before = selectionSideText(root, range, "before");
  const after = selectionSideText(root, range, "after");
  const index = normalizedTextIndex(source);

  let best: { start: number; end: number; score: number } | null = null;
  let from = 0;
  while (from <= index.text.length) {
    const at = index.text.indexOf(quote, from);
    if (at < 0) break;
    const sourceBefore = index.text.slice(Math.max(0, at - 80), at);
    const sourceAfter = index.text.slice(at + quote.length, at + quote.length + 80);
    let score = 0;
    if (before && sourceBefore.endsWith(before)) score += 2;
    if (after && sourceAfter.startsWith(after)) score += 2;
    const candidate = {
      start: index.starts[at],
      end: index.ends[at + quote.length - 1],
      score,
    };
    if (!best || candidate.score > best.score) best = candidate;
    if (score >= 4) break;
    from = at + Math.max(1, quote.length);
  }

  if (!best) return null;
  const start = Math.max(0, Math.min(best.start, source.length));
  const end = Math.max(start, Math.min(best.end, source.length));
  if (end <= start) return null;
  return {
    start,
    end,
    quote,
    sourceQuote: source.slice(start, end),
  };
}

export function documentTextAnchorFor(
  text: string,
  start: number,
  end: number,
): TextAnchor {
  return makeTextAnchor(text, start, end);
}

/**
 * DOCX has no stable character offsets of its own, so we additionally record
 * how many times the quote occurred before this selection and which
 * paragraph (blank-line separated) it sits in.
 */
export function makeDocxAnchor(
  text: string,
  start: number,
  end: number,
  quote: string,
): TextAnchor {
  const base = makeTextAnchor(text, start, end);
  const before = text.slice(0, start);
  const needle = quote || text.slice(start, end);
  let occurrence = 0;
  if (needle) {
    let from = 0;
    while (occurrence < 1000) {
      const at = before.indexOf(needle, from);
      if (at < 0) break;
      occurrence += 1;
      from = at + Math.max(1, needle.length);
    }
  }
  const paragraph = before.split(/\n\s*\n/).length;
  return { ...base, occurrence, paragraph };
}
