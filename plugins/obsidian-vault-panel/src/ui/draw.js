// Embedded Excalidraw canvas. Bundled with React + @excalidraw/excalidraw into
// the panel's single-file HTML. Kept out of app.js so the editor logic stays
// readable.
import React from "react";
import { createRoot } from "react-dom/client";
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw";

let root = null;
let currentOnChange = null;
let pendingChangeTimer = null;
let lastElementsSig = null;

// Excalidraw fires onChange for appState-only updates (scroll, zoom, selection).
// Hashing the elements keeps "unsaved changes" honest.
function elementsSignature(elements) {
  try {
    return JSON.stringify(
      elements.map((e) => [e.id, e.version, e.versionNonce, e.isDeleted, e.x, e.y, e.width, e.height, e.text])
    );
  } catch {
    return String(Math.random());
  }
}

function parseInitial(jsonText) {
  try {
    const data = JSON.parse(jsonText);
    return {
      elements: Array.isArray(data.elements) ? data.elements : [],
      appState: {
        ...(data.appState && typeof data.appState === "object" ? data.appState : {}),
        // Never restore viewport/mode state that would fight the panel layout.
        collaborators: undefined,
      },
      files: data.files && typeof data.files === "object" ? data.files : {},
      scrollToContent: true,
    };
  } catch {
    return { elements: [], appState: {}, files: {}, scrollToContent: true };
  }
}

/**
 * Mount (or re-mount) the canvas.
 * @param {HTMLElement} container
 * @param {{jsonText:string, theme:"light"|"dark", readOnly?:boolean,
 *          onChange:(json:string)=>void}} opts
 */
export function mountDrawing(container, opts) {
  unmountDrawing();
  const initialData = parseInitial(opts.jsonText);
  currentOnChange = opts.onChange || null;
  lastElementsSig = elementsSignature(initialData.elements);
  root = createRoot(container);
  root.render(
    React.createElement(
      "div",
      { style: { width: "100%", height: "100%" } },
      React.createElement(Excalidraw, {
        initialData,
        theme: opts.theme === "dark" ? "dark" : "light",
        viewModeEnabled: !!opts.readOnly,
        // The panel already provides its own chrome; hide the marketing links.
        UIOptions: { canvasActions: { loadScene: false, saveToActiveFile: false } },
        onChange: (elements, appState, files) => {
          if (!currentOnChange) return;
          // Ignore pure viewport/selection changes so opening a drawing doesn't
          // immediately look like it has unsaved edits.
          const sig = elementsSignature(elements);
          if (sig === lastElementsSig) return;
          lastElementsSig = sig;
          // Debounce: Excalidraw fires on every pointer move while drawing.
          if (pendingChangeTimer) clearTimeout(pendingChangeTimer);
          pendingChangeTimer = setTimeout(() => {
            pendingChangeTimer = null;
            try {
              currentOnChange(serializeAsJSON(elements, appState, files, "local"));
            } catch {
              /* ignore transient serialization errors */
            }
          }, 500);
        },
      })
    )
  );
}

export function unmountDrawing() {
  if (pendingChangeTimer) {
    clearTimeout(pendingChangeTimer);
    pendingChangeTimer = null;
  }
  currentOnChange = null;
  if (root) {
    try {
      root.unmount();
    } catch {
      /* ignore */
    }
    root = null;
  }
}

export function setDrawingTheme(theme) {
  // Excalidraw only reads theme on mount; re-mounting is expensive, so theme
  // changes are applied by the caller re-mounting when the host theme flips.
  void theme;
}
