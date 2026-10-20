import React, { useMemo } from "react";
import { renderHighlightedRun, type RenderAnnotation } from "./highlight.js";
import { PinOverlay } from "./pins.js";

const CHUNK_CHARS = 12000;

interface Chunk {
  start: number;
  end: number;
  text: string;
}

function splitChunks(source: string): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + CHUNK_CHARS);
    if (end < source.length) {
      const nextBreak = source.indexOf("\n", end);
      if (nextBreak >= 0 && nextBreak - end < 4000) end = nextBreak + 1;
    }
    chunks.push({ start, end, text: source.slice(start, end) });
    start = end;
  }
  if (chunks.length === 0) chunks.push({ start: 0, end: 0, text: "" });
  return chunks;
}

export interface TextViewProps {
  source: string;
  annotations: RenderAnnotation[];
  activeId: string | null;
  onMarkClick: (id: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  monospace: boolean;
  numberById: Map<string, number>;
  revision?: string;
}

export const TextView = React.memo(function TextView({
  source,
  annotations,
  activeId,
  onMarkClick,
  containerRef,
  monospace,
  numberById,
  revision,
}: TextViewProps) {
  const chunks = useMemo(() => splitChunks(source), [source]);
  return (
    <div className={`text-body${monospace ? " text-mono" : ""}`} ref={containerRef}>
      {chunks.map((chunk) => (
        <div
          className="text-chunk"
          key={chunk.start}
          data-s={chunk.start}
          data-e={chunk.end}
        >
          {renderHighlightedRun(
            chunk.text,
            chunk.start,
            chunk.end,
            annotations,
            activeId,
            onMarkClick,
            `chunk-${chunk.start}`,
          )}
        </div>
      ))}
      <PinOverlay
        containerRef={containerRef}
        annotations={annotations}
        activeId={activeId}
        numberById={numberById}
        onPinClick={onMarkClick}
        revision={revision}
      />
    </div>
  );
});
