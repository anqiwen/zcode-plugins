import React from "react";
import type { Annotation } from "../shared/types.js";

/** A real annotation, or a temporary highlight for a selection being composed. */
export type RenderAnnotation = Annotation & { pending?: boolean };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Splits [start, end) into plain text and <mark> segments for every
 * annotation that overlaps the range.
 */
export function renderHighlightedRun(
  text: string,
  start: number,
  end: number,
  annotations: RenderAnnotation[],
  activeId: string | null,
  onMarkClick: (id: string) => void,
  keyBase: string,
): React.ReactNode {
  const hits = annotations.filter(
    (annotation) =>
      annotation.anchor.kind === "text" &&
      annotation.anchor.start < end &&
      annotation.anchor.end > start,
  );
  if (hits.length === 0) return text;

  const boundaries = new Set<number>([start, end]);
  for (const hit of hits) {
    if (hit.anchor.kind !== "text") continue;
    boundaries.add(clamp(hit.anchor.start, start, end));
    boundaries.add(clamp(hit.anchor.end, start, end));
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const nodes: React.ReactNode[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i];
    const to = sorted[i + 1];
    if (to <= from) continue;
    const covering = hits.find(
      (hit) =>
        hit.anchor.kind === "text" && hit.anchor.start <= from && hit.anchor.end >= to,
    );
    const segment = text.slice(from - start, to - start);
    if (!covering) {
      nodes.push(segment);
      continue;
    }
    nodes.push(
      <mark
        key={`${keyBase}-m-${i}`}
        data-annotation-id={covering.id}
        className={[
          "hl",
          covering.pending
            ? "hl-pending"
            : covering.status === "sent"
              ? "hl-sent"
              : "hl-draft",
          covering.id === activeId ? "hl-active" : "",
          covering.stale ? "hl-stale" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        title={covering.pending ? "待保存的批注" : covering.comment.slice(0, 200)}
        onClick={
          covering.pending
            ? undefined
            : (event) => {
                event.stopPropagation();
                onMarkClick(covering.id);
              }
        }
      >
        {segment}
      </mark>,
    );
  }
  return nodes;
}
