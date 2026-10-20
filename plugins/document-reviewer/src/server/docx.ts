import mammoth from "mammoth/mammoth.browser.js";
import { parse, NodeType, type HTMLElement, type Node } from "node-html-parser";

export interface DocxConversion {
  markdown: string;
  warnings: string[];
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

function wrapInline(marker: string, text: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || !match[2]) return text;
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function inlineText(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return node.text ?? "";
  if (node.nodeType !== NodeType.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  const tag = element.tagName?.toLowerCase() ?? "";
  const children = () => element.childNodes.map(inlineText).join("");

  switch (tag) {
    case "strong":
    case "b":
      return wrapInline("**", children());
    case "em":
    case "i":
      return wrapInline("*", children());
    case "code":
      return `\`${children().replace(/`/g, "'")}\``;
    case "br":
      return "\n";
    case "img": {
      const alt = element.getAttribute("alt")?.trim();
      return alt ? `[图片：${alt}]` : "[图片]";
    }
    case "a": {
      const href = element.getAttribute("href");
      const text = children();
      return href && /^https?:/i.test(href) && text ? `[${text}](${href})` : text;
    }
    case "sup":
    case "sub":
      return children();
    default:
      return children();
  }
}

function listItems(list: HTMLElement, ordered: boolean, depth: number): string[] {
  const lines: string[] = [];
  const items = list.childNodes.filter(
    (node) =>
      node.nodeType === NodeType.ELEMENT_NODE &&
      (node as HTMLElement).tagName?.toLowerCase() === "li",
  ) as HTMLElement[];
  let index = 1;
  for (const item of items) {
    const nested: string[] = [];
    let text = "";
    for (const child of item.childNodes) {
      if (child.nodeType === NodeType.ELEMENT_NODE) {
        const tag = (child as HTMLElement).tagName?.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          nested.push(...listItems(child as HTMLElement, tag === "ol", depth + 1));
          continue;
        }
      }
      text += inlineText(child);
    }
    const indent = "  ".repeat(depth);
    const marker = ordered ? `${index}. ` : "- ";
    const clean = text.replace(/\s*\n\s*/g, " ").trim();
    if (clean) lines.push(`${indent}${marker}${clean}`);
    lines.push(...nested);
    index += 1;
  }
  return lines;
}

function tableRows(table: HTMLElement): string[][] {
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tr")) {
    const cells = tr.childNodes
      .filter(
        (node) =>
          node.nodeType === NodeType.ELEMENT_NODE &&
          ["td", "th"].includes((node as HTMLElement).tagName?.toLowerCase() ?? ""),
      )
      .map((cell) => escapeTableCell(inlineText(cell)));
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function renderTable(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
  const header = normalized[0];
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ];
  return [...lines, ""];
}

function renderBlocks(nodes: Node[], out: string[]): void {
  for (const node of nodes) {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = (node.text ?? "").trim();
      if (text) out.push(text, "");
      continue;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) continue;
    const element = node as HTMLElement;
    const tag = element.tagName?.toLowerCase() ?? "";

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      out.push(`${"#".repeat(level)} ${inlineText(element).trim()}`, "");
      continue;
    }
    switch (tag) {
      case "p": {
        const text = inlineText(element).trim();
        if (text) out.push(text, "");
        break;
      }
      case "ul":
        out.push(...listItems(element, false, 0), "");
        break;
      case "ol":
        out.push(...listItems(element, true, 0), "");
        break;
      case "table":
        out.push(...renderTable(tableRows(element)));
        break;
      case "blockquote": {
        const inner: string[] = [];
        renderBlocks(element.childNodes, inner);
        const text = inner.filter((line) => line !== "").join("\n");
        if (text) {
          out.push(
            ...text.split("\n").map((line) => `> ${line}`),
            "",
          );
        }
        break;
      }
      case "pre": {
        const code = element.text.replace(/\n+$/, "");
        if (code) out.push("```", code, "```", "");
        break;
      }
      case "img": {
        const alt = element.getAttribute("alt")?.trim();
        out.push(alt ? `[图片：${alt}]` : "[图片]", "");
        break;
      }
      case "hr":
        out.push("---", "");
        break;
      default:
        renderBlocks(element.childNodes, out);
        break;
    }
  }
}

/**
 * Converts a DOCX buffer to a clean Markdown preview. The output is the
 * canonical text the panel anchors against; DOCX itself has no stable
 * character offsets, so annotations are located by quote + context.
 */
export async function docxToMarkdown(buffer: Buffer): Promise<DocxConversion> {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  const result = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })),
    },
  );
  const root = parse(result.value, { blockTextElements: { pre: true } });
  const body = root.querySelector("body") ?? root;
  const lines: string[] = [];
  renderBlocks(body.childNodes, lines);
  const markdown = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Word's built-in styles and OMML math are expected; Mammoth reports both as noise.
  const benignWarnings = [
    /^An unrecognised element was ignored:/i,
    /^An unrecognized element was ignored:/i,
    /^Unrecognised (paragraph|run|table|numbering) style:/i,
    /^Unrecognized (paragraph|run|table|numbering) style:/i,
  ];
  return {
    markdown,
    warnings: result.messages
      .map((message: { message: string }) => message.message)
      .filter((message: string) => !benignWarnings.some((pattern) => pattern.test(message))),
  };
}
