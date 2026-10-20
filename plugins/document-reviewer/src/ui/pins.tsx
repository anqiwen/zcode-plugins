import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
} from "react";
import type { RenderAnnotation } from "./highlight.js";

interface PinPosition {
  id: string;
  number: string;
  top: number;
  left: number;
  active: boolean;
  sent: boolean;
  stale: boolean;
}

export interface PinOverlayProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  annotations: RenderAnnotation[];
  activeId: string | null;
  numberById: Map<string, number>;
  onPinClick: (id: string) => void;
  /** Changes whenever the rendered document changes. */
  revision?: string;
}

function samePins(a: PinPosition[], b: PinPosition[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].id !== b[i].id ||
      a[i].number !== b[i].number ||
      a[i].top !== b[i].top ||
      a[i].left !== b[i].left ||
      a[i].active !== b[i].active ||
      a[i].sent !== b[i].sent ||
      a[i].stale !== b[i].stale
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Numbered margin pins, positioned from the last <mark> of each annotation.
 * The layer never mutates the document DOM, so text selection keeps working.
 */
export function PinOverlay({
  containerRef,
  annotations,
  activeId,
  numberById,
  onPinClick,
  revision,
}: PinOverlayProps) {
  const [pins, setPins] = useState<PinPosition[]>([]);

  const update = useCallback(() => {
    const root = containerRef.current;
    if (!root) return;
    const rootRect = root.getBoundingClientRect();
    const byId = new Map<string, HTMLElement[]>();
    root.querySelectorAll<HTMLElement>("mark.hl[data-annotation-id]").forEach((mark) => {
      if (mark.classList.contains("hl-pending")) return;
      const id = mark.dataset.annotationId;
      if (!id) return;
      const list = byId.get(id) ?? [];
      list.push(mark);
      byId.set(id, list);
    });

    const annotationById = new Map(annotations.map((annotation) => [annotation.id, annotation]));
    const next: PinPosition[] = [];
    for (const [id, marks] of byId) {
      const annotation = annotationById.get(id);
      if (!annotation) continue;
      const last = marks[marks.length - 1];
      const rect = last.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      next.push({
        id,
        number: String(numberById.get(id) ?? "·"),
        top: rect.top - rootRect.top + 2,
        left: Math.max(0, root.clientWidth - 18),
        active: id === activeId,
        sent: annotation.status === "sent",
        stale: Boolean(annotation.stale),
      });
    }

    next.sort((a, b) => a.top - b.top);
    let lastBottom = Number.NEGATIVE_INFINITY;
    for (const pin of next) {
      if (pin.top < lastBottom) pin.top = lastBottom;
      lastBottom = pin.top + 20;
    }
    setPins((current) => (samePins(current, next) ? current : next));
  }, [activeId, annotations, containerRef, numberById]);

  useLayoutEffect(() => {
    update();
  }, [update, revision]);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const scroll = root.closest(".scroll-area") ?? root;
    let raf = 0;
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(update);
    };
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(root);
    if (document.fonts?.ready) {
      void document.fonts.ready.then(schedule).catch(() => undefined);
    }
    return () => {
      window.cancelAnimationFrame(raf);
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [containerRef, update]);

  if (pins.length === 0) return null;

  return (
    <div className="annotation-pin-layer">
      {pins.map((pin) => (
        <button
          key={pin.id}
          type="button"
          className={[
            "annotation-pin",
            pin.active ? "active" : "",
            pin.sent ? "sent" : "",
            pin.stale ? "stale" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          data-annotation-id={pin.id}
          style={{ top: pin.top, left: pin.left }}
          title={pin.stale ? `批注 ${pin.number}（位置待核对）` : `批注 ${pin.number}`}
          aria-label={`批注 ${pin.number}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation();
            onPinClick(pin.id);
          }}
        >
          {pin.number}
        </button>
      ))}
    </div>
  );
}
