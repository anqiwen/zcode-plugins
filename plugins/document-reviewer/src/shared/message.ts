import type { Annotation, AnnotationIntent } from "./types.js";

export const INTENT_LABELS: Record<AnnotationIntent, string> = {
  edit: "修改",
  delete: "删除",
  ask: "疑问",
};

export function annotationIntent(annotation: Annotation): AnnotationIntent {
  return annotation.intent ?? "edit";
}

export function intentLabel(intent?: AnnotationIntent): string {
  return INTENT_LABELS[intent ?? "edit"];
}

export interface MessageDocument {
  path: string;
  hash: string;
}

export function positionLabel(annotation: Annotation): string {
  const anchor = annotation.anchor;
  if (anchor.kind === "pdf") {
    return `第 ${anchor.page} 页（文本块 ${anchor.startItem + 1}–${anchor.endItem + 1}）`;
  }
  const lineLabel =
    anchor.startLine === anchor.endLine
      ? `第 ${anchor.startLine} 行`
      : `第 ${anchor.startLine}–${anchor.endLine} 行`;
  if (annotation.docKind === "docx") {
    const paragraph =
      anchor.paragraph && anchor.paragraph > 0 ? `，第 ${anchor.paragraph} 段` : "";
    const occurrence =
      anchor.occurrence !== undefined
        ? `，原文第 ${anchor.occurrence + 1} 次出现`
        : "";
    return `DOCX 转换预览 ${lineLabel}（字符 ${anchor.start}–${anchor.end}${paragraph}${occurrence}）`;
  }
  return `${lineLabel}（字符 ${anchor.start}–${anchor.end}）`;
}

function quoteBlock(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Builds the single structured message that is handed to the main Agent.
 * Annotations are grouped by file and numbered globally, matching the UI.
 */
export function buildReviewMessage(
  annotations: Annotation[],
  documents: MessageDocument[],
): string {
  const docHash = new Map(documents.map((doc) => [doc.path, doc.hash]));
  const sorted = [...annotations].sort((a, b) => {
    if (a.docPath !== b.docPath) return a.docPath.localeCompare(b.docPath);
    const aStart = a.anchor.kind === "pdf" ? a.anchor.page * 1e9 + a.anchor.startItem : a.anchor.start;
    const bStart = b.anchor.kind === "pdf" ? b.anchor.page * 1e9 + b.anchor.startItem : b.anchor.start;
    return aStart - bStart;
  });

  const perFile = new Map<string, number>();
  for (const annotation of sorted) {
    perFile.set(annotation.docPath, (perFile.get(annotation.docPath) ?? 0) + 1);
  }

  const lines: string[] = [];
  lines.push("请根据以下文档批注处理对应的原始文件。批注分为「修改」「删除」「疑问」三种意图。");
  lines.push("");
  lines.push("工作原则：");
  lines.push("1. 逐条定位原文，确认位置正确。");
  lines.push("2. 修改前将每个被修改的原文件备份为同目录下的“<原文件名>.bak”；若已存在，追加时间戳，不要覆盖已有备份。");
  lines.push("3. 「修改」按意见改写对应原文；「删除」删除对应原文内容（选区是整段的，删除该段），不要误删相邻内容；「疑问」只在回复中解答，不要改动文件，等用户确认后再处理。");
  lines.push("4. 仅修改批注要求涉及的内容，不随意重写未批注段落。");
  lines.push("5. 不改变实验数据、统计结果、参考文献和科学含义。");
  lines.push("6. 如果批注要求与原文冲突，先解释问题。");
  lines.push("7. 如果存在无法可靠定位的选区，不要猜测修改位置。");
  lines.push("8. 修改完成后，逐条列出处理结果，并提示用户在文档批注面板中点击「刷新」查看更新后的文件。");
  lines.push("");
  lines.push("文档清单：");
  for (const [path, count] of perFile) {
    const hash = docHash.get(path);
    const hashLabel = hash ? `；文件哈希 sha256:${hash.slice(0, 16)}` : "";
    lines.push(`- ${path}（${count} 条批注${hashLabel}）`);
  }
  if (annotations.some((annotation) => annotation.docKind === "docx")) {
    lines.push("");
    lines.push(
      "注意：.docx 批注基于 Markdown 转换预览定位，字符偏移不对应 Word 内部位置；请以原文、前后文和出现序号在 Word 文件中核对后再修改。",
    );
  }
  lines.push("");
  lines.push("批注列表：");
  lines.push("");

  sorted.forEach((annotation, index) => {
    const number = index + 1;
    const intent = annotationIntent(annotation);
    lines.push(`[批注 ${number}]`);
    lines.push(`文件：${annotation.docPath}`);
    lines.push(`意图：${intentLabel(intent)}`);
    lines.push(`位置：${positionLabel(annotation)}`);
    if (annotation.stale) {
      lines.push("注意：该文件在批注创建后已发生变化，请先核对原文是否仍然存在。");
    }
    if (annotation.docKind === "docx") {
      lines.push("定位方式：按转换预览中的原文文本匹配，请在 Word 原文中核对。");
    }
    lines.push("原文：");
    lines.push(quoteBlock(annotation.quote));
    const anchor = annotation.anchor;
    if (anchor.prefix) lines.push(`前文：…${oneLine(anchor.prefix, 120)}`);
    if (anchor.suffix) lines.push(`后文：${oneLine(anchor.suffix, 120)}…`);
    if (intent === "delete") {
      lines.push("处理方式：删除上述原文对应的内容（整段选区则删除该段），不要改动其他内容。");
    } else if (intent === "ask") {
      lines.push("处理方式：只回答上述问题，不要修改文件；等用户确认后再处理。");
    }
    lines.push("批注意见：");
    lines.push(annotation.comment.trim());
    lines.push("");
  });

  lines.push("处理完成后，请返回逐条处理清单，格式如下：");
  lines.push("- [批注 N] 已修改 / 无需修改 / 无法定位：<简要说明>");
  lines.push("");
  lines.push("如果某一处无法可靠定位或修改要求与原文冲突，请明确说明原因，不要猜测。");

  return lines.join("\n");
}
