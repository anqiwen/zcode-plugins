import React, { useMemo } from "react";
import MarkdownIt from "markdown-it";
import { buildLineOffsets } from "./text.js";
import { renderHighlightedRun, type RenderAnnotation } from "./highlight.js";
import { PinOverlay } from "./pins.js";

interface MdToken {
  type: string;
  tag: string;
  content: string;
  markup: string;
  info: string;
  map: [number, number] | null;
  level: number;
  children: MdToken[] | null;
  attrGet(name: string): string | null;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
});

interface BlockCtx {
  base: number;
  end: number;
  cursor: number;
}

interface Frame {
  tag: string;
  props: Record<string, unknown>;
  children: React.ReactNode[];
  ownsBlock: boolean;
  key: string;
}

export interface MarkdownViewProps {
  source: string;
  annotations: RenderAnnotation[];
  activeId: string | null;
  onMarkClick: (id: string) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
  numberById: Map<string, number>;
  revision?: string;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findLoose(
  haystack: string,
  needle: string,
  from: number,
): { index: number; length: number } | null {
  if (!needle) return null;
  const direct = haystack.indexOf(needle, from);
  if (direct >= 0) return { index: direct, length: needle.length };
  const parts = needle.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const pattern = parts.map(escapeRegExp).join("\\s+");
  const match = new RegExp(pattern).exec(haystack.slice(from));
  if (!match) return null;
  return { index: from + match.index, length: match[0].length };
}


export const MarkdownView = React.memo(function MarkdownView({
  source,
  annotations,
  activeId,
  onMarkClick,
  containerRef,
  numberById,
  revision,
}: MarkdownViewProps) {
  const content = useMemo(() => {
    const tokens = md.parse(source, {}) as unknown as MdToken[];
    const lineStarts = buildLineOffsets(source);
    const nodes: React.ReactNode[] = [];
    const stack: Frame[] = [];
    const blockStack: BlockCtx[] = [];
    let counter = 0;
    const nextKey = () => `md-${counter++}`;

    const currentBlock = (): BlockCtx | null =>
      blockStack.length > 0 ? blockStack[blockStack.length - 1] : null;

    const blockFor = (token: MdToken): BlockCtx | null => {
      if (!token.map) return currentBlock();
      const base = lineStarts[token.map[0]] ?? 0;
      const end = token.map[1] < lineStarts.length ? lineStarts[token.map[1]] : source.length;
      return { base, end, cursor: base };
    };

    const append = (node: React.ReactNode) => {
      if (stack.length > 0) stack[stack.length - 1].children.push(node);
      else nodes.push(node);
    };

    const renderInline = (children: MdToken[], block: BlockCtx | null): React.ReactNode[] => {
      const out: React.ReactNode[] = [];
      if (!block) {
        for (const child of children) {
          if (child.type === "softbreak" || child.type === "hardbreak") out.push(" ");
          else out.push(child.content);
        }
        return out;
      }
      const blockSource = source.slice(block.base, block.end);
      const inlineStack: Array<{ tag: string; children: React.ReactNode[]; key: string }> = [];
      const push = (node: React.ReactNode) => {
        if (inlineStack.length > 0) inlineStack[inlineStack.length - 1].children.push(node);
        else out.push(node);
      };
      const openInline = (tag: string) => {
        inlineStack.push({ tag, children: [], key: nextKey() });
      };
      const closeInline = () => {
        const frame = inlineStack.pop();
        if (!frame) return;
        const props: Record<string, unknown> = { key: frame.key };
        let element: React.ReactNode;
        if (frame.tag === "a") {
          element = (
            <span className="md-link" {...props}>
              {frame.children}
            </span>
          );
        } else {
          element = React.createElement(frame.tag, props, ...frame.children);
        }
        if (inlineStack.length > 0) {
          inlineStack[inlineStack.length - 1].children.push(element);
        } else {
          out.push(element);
        }
      };

      for (const child of children) {
        switch (child.type) {
          case "text":
          case "code_inline": {
            const found = findLoose(blockSource, child.content, block.cursor - block.base);
            if (!found) {
              push(child.content);
              break;
            }
            const absStart = block.base + found.index;
            const absEnd = absStart + found.length;
            block.cursor = absEnd;
            if (child.type === "code_inline") {
              push(
                <code className="md-inline-code" key={nextKey()} data-s={absStart} data-e={absEnd}>
                  {renderHighlightedRun(child.content, absStart, absEnd, annotations, activeId, onMarkClick, `ic-${absStart}`)}
                </code>,
              );
            } else {
              push(
                <span key={nextKey()} data-s={absStart} data-e={absEnd}>
                  {renderHighlightedRun(child.content, absStart, absEnd, annotations, activeId, onMarkClick, `t-${absStart}`)}
                </span>,
              );
            }
            break;
          }
          case "softbreak":
            block.cursor = Math.min(block.end, block.cursor + 1);
            push(" ");
            break;
          case "hardbreak":
            block.cursor = Math.min(block.end, block.cursor + 1);
            push(<br key={nextKey()} />);
            break;
          case "strong_open":
            openInline("strong");
            break;
          case "em_open":
            openInline("em");
            break;
          case "s_open":
            openInline("s");
            break;
          case "link_open":
            openInline("a");
            break;
          case "strong_close":
          case "em_close":
          case "s_close":
          case "link_close":
            closeInline();
            break;
          case "image":
            push(
              <span className="md-image" key={nextKey()}>
                🖼 {child.content || "图片"}
              </span>,
            );
            break;
          case "html_inline":
            push(
              <span className="md-html" key={nextKey()}>
                {child.content}
              </span>,
            );
            break;
          default:
            if (child.content) push(child.content);
            break;
        }
      }
      // Close any unclosed inline formatting defensively.
      while (inlineStack.length > 0) closeInline();
      return out;
    };

    for (const token of tokens) {
      if (token.type.endsWith("_open")) {
        const tag = token.type === "heading_open" ? token.tag : tagForOpen(token.type);
        if (!tag) continue;
        const ownsBlock = Boolean(token.map);
        if (ownsBlock) blockStack.push(blockFor(token)!);
        const props: Record<string, unknown> = {};
        if (token.type === "ordered_list_open") {
          const start = token.attrGet("start");
          if (start) props.start = Number(start);
        }
        stack.push({ tag, props, children: [], ownsBlock, key: nextKey() });
        continue;
      }
      if (token.type.endsWith("_close")) {
        const frame = stack.pop();
        if (!frame) continue;
        if (frame.ownsBlock) blockStack.pop();
        const element = React.createElement(
          frame.tag,
          { key: frame.key, ...frame.props },
          ...frame.children,
        );
        append(element);
        continue;
      }
      switch (token.type) {
        case "inline": {
          const block = blockFor(token) ?? currentBlock();
          const temp = block ? { ...block } : null;
          const inlineNodes = renderInline(token.children ?? [], temp);
          if (temp && token.map) {
            // The inline token owns its own cursor; nothing to persist.
          } else if (temp && block) {
            block.cursor = temp.cursor;
          }
          for (const node of inlineNodes) append(node);
          break;
        }
        case "fence":
        case "code_block": {
          const block = blockFor(token);
          let code: React.ReactNode = token.content;
          if (block) {
            const found = findLoose(source.slice(block.base, block.end), token.content, 0);
            if (found) {
              const absStart = block.base + found.index;
              code = (
                <span data-s={absStart} data-e={absStart + found.length}>
                  {renderHighlightedRun(token.content, absStart, absStart + found.length, annotations, activeId, onMarkClick, `code-${absStart}`)}
                </span>
              );
            }
          }
          append(
            <pre className="md-code" key={nextKey()}>
              <code>{code}</code>
            </pre>,
          );
          break;
        }
        case "hr":
          append(<hr key={nextKey()} />);
          break;
        case "html_block":
          append(
            <pre className="md-html-block" key={nextKey()}>
              {token.content}
            </pre>,
          );
          break;
        default:
          if (token.content) append(token.content);
          break;
      }
    }
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.ownsBlock) blockStack.pop();
      append(React.createElement(frame.tag, { key: frame.key }, ...frame.children));
    }
    return nodes;
  }, [source, annotations, activeId, onMarkClick]);

  return (
    <div className="md-body" ref={containerRef}>
      {content}
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

function tagForOpen(type: string): string | null {
  switch (type) {
    case "paragraph_open":
      return "p";
    case "bullet_list_open":
      return "ul";
    case "ordered_list_open":
      return "ol";
    case "list_item_open":
      return "li";
    case "blockquote_open":
      return "blockquote";
    case "table_open":
      return "table";
    case "thead_open":
      return "thead";
    case "tbody_open":
      return "tbody";
    case "tr_open":
      return "tr";
    case "th_open":
      return "th";
    case "td_open":
      return "td";
    default:
      return null;
  }
}
