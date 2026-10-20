import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixtures = path.join(root, "test-fixtures");

function parseArgs(argv) {
  const out = { pdf: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--pdf") out.pdf = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pluginData = await fs.mkdtemp(path.join(os.tmpdir(), "document-reviewer-data-"));
  const externalFile = path.join(
    os.tmpdir(),
    `document-reviewer-external-${Date.now()}.md`,
  );
  await fs.writeFile(externalFile, "# 外部文件\n\n工作区之外的测试内容。\n", "utf8");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.SMOKE_SERVER || path.join(root, "dist", "server.mjs")],
    cwd: fixtures,
    env: {
      ...process.env,
      ZCODE_WORKSPACE_ROOT: fixtures,
      ZCODE_PLUGIN_DATA: pluginData,
      ZCODE_TEST_PICK_FILE: externalFile,
    },
    stderr: "pipe",
  });

  const client = new Client({ name: "smoke", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  console.log("connected");

  const tools = await client.listTools();
  console.log(
    "tools:",
    tools.tools.map((tool) => tool.name).join(", "),
  );
  const showTool = tools.tools.find((tool) => tool.name === "show_reviewer");
  console.log("show_reviewer meta:", JSON.stringify(showTool?._meta));
  const sidebarTool = tools.tools.find((tool) => tool.name === "show_reviewer_sidebar");
  console.log("show_reviewer_sidebar meta:", JSON.stringify(sidebarTool?._meta));
  const externalTool = tools.tools.find((tool) => tool.name === "open_external_document");
  console.log("open_external_document meta:", JSON.stringify(externalTool?._meta));
  const pickerTool = tools.tools.find((tool) => tool.name === "pick_external_document");
  console.log("pick_external_document meta:", JSON.stringify(pickerTool?._meta));
  const resources = await client.listResources();
  console.log(
    "resources:",
    resources.resources.map((resource) => resource.uri).join(", "),
  );

  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.structuredContent?.ok === false) {
      throw new Error(`${name}: ${JSON.stringify(result.structuredContent.error)}`);
    }
    return result.structuredContent?.data ?? result;
  };

  const workspace = await call("get_workspace_info");
  console.log("workspace:", workspace.root);

  const list = await call("list_documents", { limit: 50 });
  console.log(
    "documents:",
    list.items.map((item) => item.path).join(", "),
  );

  const md = list.items.find((item) => item.path.endsWith(".md"));
  if (!md) throw new Error("no markdown fixture found");

  const opened = await call("open_document", { path: md.path });
  console.log("opened:", opened.document.path, opened.document.kind, opened.document.hash.slice(0, 12));

  const textDocs = [];
  for (let i = 0; i < opened.document.chunkCount; i += 1) {
    const resource = await client.readResource({
      uri: `ui://document-reviewer/file/${opened.document.token}/${i}`,
    });
    textDocs.push(resource.contents[0].text ?? "");
  }
  const text = textDocs.join("");
  console.log("chunks:", opened.document.chunkCount, "chars:", text.length);

  const read = await call("read_document_text", { path: md.path, limit: 120 });
  console.log("read_document_text sample:", JSON.stringify(read.text.slice(0, 60)));

  const probe = text.slice(text.indexOf("\n") + 1, text.indexOf("\n") + 20).trim();
  const anchor = await call("compute_text_anchor", { path: md.path, quote: probe });
  console.log("anchor:", JSON.stringify(anchor).slice(0, 220));

  const annotation = {
    id: "a1",
    docPath: md.path,
    docKind: "md",
    docHash: opened.document.hash,
    quote: probe,
    comment: "这句话的依据是什么？",
    intent: "ask",
    anchor: { ...anchor.anchor, occurrence: 0, paragraph: 3 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "draft",
  };
  const saved = await call("save_drafts", { annotations: [annotation], lastDocPath: md.path });
  console.log("save_drafts:", JSON.stringify(saved));
  const loaded = await call("load_drafts");
  console.log(
    "load_drafts count:",
    loaded.store.annotations.length,
    "intent:",
    loaded.store.annotations[0]?.intent,
    "occurrence:",
    loaded.store.annotations[0]?.anchor?.occurrence,
    "paragraph:",
    loaded.store.annotations[0]?.anchor?.paragraph,
  );
  const check = await call("check_documents", { paths: [md.path] });
  console.log("check_documents:", check.documents[0].hash.slice(0, 12));

  const panel = await client.readResource({ uri: "ui://document-reviewer/panel.html" });
  const html = panel.contents[0].text ?? "";
  console.log("panel:", panel.contents[0].mimeType, html.length, "bytes, root=", html.includes('id="root"'));

  const worker = await client.readResource({
    uri: "ui://document-reviewer/assets/pdf-worker.js",
  });
  const workerBytes = Buffer.from(worker.contents[0].blob ?? "", "base64").length;
  console.log("pdf worker:", worker.contents[0].mimeType, workerBytes, "bytes");

  const cmap = await client.readResource({
    uri: "ui://document-reviewer/assets/pdfjs/cmaps/UniGB-UCS2-H.bcmap",
  });
  console.log(
    "cmap:",
    Buffer.from(cmap.contents[0].blob ?? "", "base64").length,
    "bytes",
  );

  if (args.pdf) {
    const openedPdf = await call("open_document", { path: args.pdf });
    console.log(
      "pdf:",
      openedPdf.document.name,
      openedPdf.document.chunkCount,
      "chunks",
      openedPdf.document.size,
      "bytes",
    );
    const first = await client.readResource({
      uri: `ui://document-reviewer/file/${openedPdf.document.token}/0`,
    });
    const head = Buffer.from(first.contents[0].blob ?? "", "base64").subarray(0, 5).toString("latin1");
    console.log("pdf header:", JSON.stringify(head), "mime:", first.contents[0].mimeType);
  }

  const docxEntry = list.items.find((item) => item.path.endsWith(".docx") && (!process.env.SMOKE_DOCX || item.path === process.env.SMOKE_DOCX));
  if (docxEntry) {
    const openedDocx = await call("open_document", { path: docxEntry.path });
    console.log(
      "docx:",
      openedDocx.document.path,
      "converted=",
      openedDocx.document.converted,
      "chunks=",
      openedDocx.document.chunkCount,
      "warnings=",
      (openedDocx.document.warnings || []).length,
    );
    const docxParts = [];
    for (let i = 0; i < openedDocx.document.chunkCount; i += 1) {
      const resource = await client.readResource({
        uri: `ui://document-reviewer/file/${openedDocx.document.token}/${i}`,
      });
      docxParts.push(resource.contents[0].text ?? "");
    }
    const docxText = docxParts.join("");
    console.log("docx preview chars:", docxText.length, JSON.stringify(docxText.slice(0, 80)));
    const docxQuote = docxText
      .split("\n")
      .find((line) => line.trim().length > 20)
      ?.trim()
      .slice(0, 24);
    if (docxQuote) {
      const docxAnchor = await call("compute_text_anchor", { path: docxEntry.path, quote: docxQuote });
      console.log("docx anchor:", docxAnchor.found, docxAnchor.anchor?.start, docxAnchor.anchor?.end);
      console.log("docx has table:", docxText.includes("| --- |"), "has list:", docxText.includes("- 列表项目 A"));
    }
  }

  const cleared = await call("clear_drafts");
  console.log("clear_drafts remaining:", cleared.remaining);

  try {
    try {
      await call("read_document_text", { path: externalFile, limit: 10 });
      console.log("external read before open: UNEXPECTED SUCCESS");
    } catch (error) {
      console.log("external read before open rejected:", String(error.message).slice(0, 90));
    }
    const picked = await call("pick_external_document");
    console.log("picker path:", picked.path);
    const external = await call("open_external_document", { path: picked.path });
    console.log(
      "external open:",
      external.document.path,
      "external=",
      external.document.external,
    );
    const externalRead = await call("read_document_text", {
      path: externalFile,
      limit: 20,
    });
    console.log("external read after open:", JSON.stringify(externalRead.text));
    const externalCheck = await call("check_documents", {
      paths: [external.document.path],
    });
    console.log(
      "external check:",
      externalCheck.documents[0].hash?.slice(0, 12),
      "missing=",
      externalCheck.documents[0].missing,
    );
    const externalStatus = await call("get_document_status", {
      path: external.document.path,
    });
    console.log(
      "external status:",
      externalStatus.path,
      "hash=",
      externalStatus.hash?.slice(0, 12),
    );
    const externalAnchor = await call("compute_text_anchor", {
      path: external.document.path,
      quote: "工作区之外",
    });
    console.log(
      "external anchor:",
      externalAnchor.found,
      externalAnchor.anchor?.start,
    );
  } finally {
    await fs.rm(externalFile, { force: true });
  }

  await client.close();
  await fs.rm(pluginData, { recursive: true, force: true });
  console.log("SMOKE OK");
}

main().catch((error) => {
  console.error("SMOKE FAILED");
  console.error(error);
  process.exit(1);
});
