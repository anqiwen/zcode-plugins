// Obsidian-style Live Preview for CodeMirror 6.
// Renders Markdown in place: hides syntax marks, styles content, keeps the
// cursor's own line as raw source. All edits still hit the real .md text.
import { EditorView, ViewPlugin, Decoration, WidgetType, keymap } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";

// ---------------------------------------------------------------- CM theme
const cmTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "14px", backgroundColor: "transparent", color: "var(--fg)" },
  ".cm-scroller": { fontFamily: "var(--sans)", lineHeight: "1.75", overflow: "auto" },
  ".cm-content": { padding: "16px 24px 80px", caretColor: "var(--accent)", maxWidth: "900px" },
  ".cm-line": { padding: "0" },
  "&.cm-focused": { outline: "none" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--accent-bg)" },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-lp-hidden": { display: "none" },
  ".cm-lp-h1": { fontSize: "1.75em", fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h2": { fontSize: "1.45em", fontWeight: "700", lineHeight: "1.35" },
  ".cm-lp-h3": { fontSize: "1.22em", fontWeight: "700" },
  ".cm-lp-h4, .cm-lp-h5, .cm-lp-h6": { fontSize: "1.08em", fontWeight: "700" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", color: "var(--muted)" },
  ".cm-lp-mark": { backgroundColor: "#fde68a", color: "#422006", borderRadius: "2px" },
  ".cm-lp-code": {
    fontFamily: "var(--mono)", fontSize: ".88em", background: "var(--surface)",
    borderRadius: "4px", padding: "1px 4px",
  },
  ".cm-lp-link": { color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: "2px" },
  ".cm-lp-wiki": { color: "var(--accent)", borderBottom: "1px dashed var(--accent)" },
  ".cm-lp-quote": { color: "var(--muted)", fontStyle: "italic" },
  ".cm-lp-fm": { color: "var(--subtle)", fontFamily: "var(--mono)", fontSize: ".85em" },
  ".cm-lp-codeblock": { fontFamily: "var(--mono)", fontSize: ".86em", color: "var(--muted)" },
  ".cm-lp-embed": {
    display: "inline-block", color: "var(--muted)", background: "var(--surface)",
    border: "1px solid var(--line)", borderRadius: "6px", padding: "0 8px", fontSize: ".85em",
  },
  ".cm-lp-taskbox": { cursor: "pointer", marginRight: "6px", verticalAlign: "middle" },
});

// ---------------------------------------------------------------- widgets
class TaskWidget extends WidgetType {
  constructor(checked, innerPos) { super(); this.checked = checked; this.innerPos = innerPos; }
  eq(o) { return o.checked === this.checked && o.innerPos === this.innerPos; }
  toDOM(view) {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-taskbox";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.innerPos, to: this.innerPos + 1, insert: this.checked ? " " : "x" } });
    });
    return box;
  }
  ignoreEvent() { return false; }
}

class TextWidget extends WidgetType {
  constructor(text, cls) { super(); this.text = text; this.cls = cls; }
  eq(o) { return o.text === this.text && o.cls === this.cls; }
  toDOM() {
    const s = document.createElement("span");
    s.className = this.cls;
    s.textContent = this.text;
    return s;
  }
  ignoreEvent() { return true; }
}

// ---------------------------------------------------------------- decorations
const HIDDEN = Decoration.mark({ class: "cm-lp-hidden" });
const CLS = (c) => Decoration.mark({ class: c });

function buildDecorations(view) {
  const { state } = view;
  const doc = state.doc;
  const sel = state.selection.main;
  // Cursor / selection lines stay raw source — the soul of Live Preview.
  const rawLines = new Set([
    doc.lineAt(sel.head).number,
    doc.lineAt(sel.from).number,
    doc.lineAt(sel.to).number,
  ]);
  const raw = (pos) => rawLines.has(doc.lineAt(pos).number);

  const push = [];
  const mark = (from, to, deco) => {
    if (from < to && to <= doc.length && from >= 0) push.push([from, to, deco]);
  };
  // Syntax marks are only hidden on non-cursor lines.
  const hide = (from, to) => { if (!raw(from)) mark(from, to, HIDDEN); };
  const style = (from, to, c) => { if (!raw(from)) mark(from, to, CLS(c)); };

  // frontmatter: dim the whole YAML block (subdued, but fully visible/editable).
  // A collapsed widget was tried, but ViewPlugin can't supply block decorations
  // and inline replaces leave empty .cm-line rows that push content offscreen.
  let fmEnd = 0;
  if (doc.length >= 4 && doc.sliceString(0, 3) === "---") {
    const text = doc.toString();
    const end = text.indexOf("\n---", 3);
    if (end >= 0) {
      fmEnd = doc.lineAt(Math.min(end + 4, doc.length)).to;
      for (let n = 1; n <= doc.lineAt(fmEnd).number; n++) {
        const line = doc.line(n);
        if (line.to > line.from) mark(line.from, line.to, CLS("cm-lp-fm"));
      }
    }
  }

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        const t = node.name, nf = node.from, nt = node.to;
        const hm = t.match(/^ATXHeading([1-6])$/);
        if (hm) {
          const line = doc.lineAt(nf);
          const lead = line.text.match(/^#{1,6}\s+/)?.[0].length ?? 0;
          // Hide "# " marks entirely; style only the heading text (no overlap).
          hide(line.from, line.from + lead);
          style(line.from + lead, nt, "cm-lp-h" + hm[1]);
          return;
        }
        switch (t) {
          case "StrongEmphasis": style(nf, nt, "cm-lp-strong"); break;
          case "Emphasis": style(nf, nt, "cm-lp-em"); break;
          case "Strikethrough": style(nf, nt, "cm-lp-strike"); break;
          case "InlineCode": style(nf, nt, "cm-lp-code"); break;
          case "Link": style(nf, nt, "cm-lp-link"); break;
          case "Blockquote": {
            if (!raw(nf)) {
              const line = doc.lineAt(nf);
              mark(line.from, line.to, CLS("cm-lp-quote"));
            }
            break;
          }
          case "FencedCode":
          case "CodeBlock": {
            if (!raw(nf)) mark(nf, nt, CLS("cm-lp-codeblock"));
            break;
          }
          case "Image": {
            const txt = state.sliceDoc(nf, nt);
            if (/^!\[\[/.test(txt) && !raw(nf)) {
              mark(nf, nt, Decoration.replace({ widget: new TextWidget("↳ 嵌入：" + txt.slice(3, -2), "cm-lp-embed") }));
            }
            break;
          }
          case "QuoteMark":
          case "CodeMark":
          case "EmphasisMark":
          case "LinkMark":
            hide(nf, nt);
            break;
          default: break;
        }
      },
    });
  }

  // Regex fallbacks for syntax lezer-markdown doesn't parse:
  // ==highlight==, [[wikilinks]], and - [x] task boxes.
  for (const { from, to } of view.visibleRanges) {
    const lf = doc.lineAt(from).number, lt = doc.lineAt(Math.min(to, doc.length)).number;
    for (let n = lf; n <= lt; n++) {
      const line = doc.line(n);
      if (rawLines.has(n)) continue;
      const txt = line.text;
      let m;
      const hi = /==([^=\n]+)==/g;
      for (const m of txt.matchAll(hi)) {
        const a = line.from + m.index, b = a + m[0].length;
        hide(a, a + 2); hide(b - 2, b); style(a + 2, b - 2, "cm-lp-mark");
      }
      const wk = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g;
      for (const m of txt.matchAll(wk)) {
        const a = line.from + m.index, b = a + m[0].length;
        style(a, b, "cm-lp-wiki");
        hide(a, a + 2); hide(b - 2, b);
        const bar = m[0].indexOf("|");
        if (bar >= 0) { const bp = a + bar; hide(bp, bp + 1); hide(a + 2, bp); }
      }
      const tk = /^(\s*[-*+]\s+)\[([ xX])\]/;
      const tkMatch = txt.match(tk);
      if (tkMatch) {
        const boxFrom = line.from + tkMatch[1].length;
        mark(boxFrom, boxFrom + 3, Decoration.replace({
          widget: new TaskWidget(tkMatch[2].toLowerCase() === "x", boxFrom + 1),
        }));
      }
    }
  }

  // Decoration.set(..., true) lets CodeMirror sort ranges itself (a manual
  // RangeSetBuilder can't mix mark() and replace() at the same position).
  // Ranges MUST be {from, to, value} objects — plain [from,to,deco] triples
  // make CodeMirror read `undefined.startSide` and crash the ViewPlugin.
  const ranges = push
    .filter(([from, to]) => from >= 0 && from < to && to <= doc.length)
    .map(([from, to, value]) => ({ from, to, value }));
  return Decoration.set(ranges, true);
}

// ---------------------------------------------------------------- plugin
const livePlugin = ViewPlugin.fromClass(
  class {
    constructor(view) { this.decorations = buildDecorations(view); }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = buildDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations }
);

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, class: "cm-lp-h2" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.monospace, fontFamily: "var(--mono)" },
  { tag: tags.quote, color: "var(--muted)" },
]);

// Compartment lets us toggle Live Preview without recreating the editor.
export const liveCompartment = new Compartment();

export function previewExtension() {
  return [livePlugin, syntaxHighlighting(mdHighlight)];
}

export function baseExtensions() {
  return [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    markdown({ base: markdownLanguage }),
    cmTheme,
    EditorView.lineWrapping,
  ];
}

export { buildDecorations };
