// End-to-end smoke test: connect a real MCP Client to the built stdio server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SERVER = path.join(ROOT, "dist", "server.mjs");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
  console.log("  ok -", msg);
}

// MCP SDK wraps a throwing tool handler into a result with isError:true — it does
// NOT throw to the client. Assert against the returned result instead.
async function callExpectError(name, args, pattern) {
  const r = await client.callTool({ name, arguments: args });
  assert(r.isError === true, `${name} 返回 isError`);
  const t = (r.content || []).find((c) => c.type === "text")?.text || "";
  assert(pattern.test(t), `错误信息匹配 /${pattern}/: ${t.slice(0, 90)}`);
}

// --- tools/list ---
const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log("tools:", names.join(", "));
for (const n of ["list_vaults", "list_notes", "read_note", "write_note", "create_note", "create_folder", "delete_note", "search_notes", "tree_revision", "read_drawing", "write_drawing", "create_drawing", "open_vault_panel"]) {
  assert(names.includes(n), `工具存在: ${n}`);
}
const openTool = tools.tools.find((t) => t.name === "open_vault_panel");
assert(JSON.stringify(openTool._meta?.ui?.visibility) === '["model","app"]', "open_vault_panel 对模型可见");
assert(openTool._meta?.ui?.surface === "obsidian-vault", "surface id 一致");
assert(openTool._meta?.ui?.resourceUri === "ui://obsidian-vault-panel/panel.html", "resourceUri 一致");

// --- resources/read panel ---
const res = await client.readResource({ uri: "ui://obsidian-vault-panel/panel.html" });
const c = res.contents[0];
assert(c.mimeType === "text/html;profile=mcp-app", "面板 MIME = text/html;profile=mcp-app");
assert(c.text.includes("Obsidian 笔记") && c.text.includes("vaultSel"), "面板 HTML 含内联 UI");
// Check the real document markup only: third-party bundles contain literal
// "<script src=https://...>" strings (Twitter/Reddit embeds, URL helpers) that
// never load anything. Strip script bodies first.
const markupOnly = c.text.replace(/<script>[\s\S]*?<\/script>/gi, "<script></script>");
assert(!/<script[^>]+src=["']https?:/i.test(markupOnly), "面板无外域脚本标签");
assert(!/<link[^>]+href=["']https?:/i.test(markupOnly), "面板无外域样式表标签");
console.log("  panel.html size:", c.text.length, "chars");

// --- list_vaults ---
const lv = await client.callTool({ name: "list_vaults", arguments: {} });
const vaults = lv.structuredContent.vaults;
assert(Array.isArray(vaults) && vaults.length > 0, `发现 ${vaults.length} 个 vault`);
console.log("  vaults:", vaults.map((v) => `${v.name} (${v.root})`).join(" | "));
const vid = vaults[0].id;

// --- list_notes ---
const ln = await client.callTool({ name: "list_notes", arguments: { vault: vid } });
const tree = ln.structuredContent.tree;
assert(tree.type === "dir" && Array.isArray(tree.children), "目录树结构正确");
function countFiles(n) {
  return n.type === "file" ? 1 : (n.children || []).reduce((a, c) => a + countFiles(c), 0);
}
console.log("  .md count in first vault:", countFiles(tree));

// --- path traversal guard ---
await callExpectError("read_note", { vault: vid, path: "../../../etc/passwd" }, /越出|ENOENT|no such/i);

// --- create / read / write round-trip on a temp note in the vault ---
const tmpName = `.__zcode_panel_smoke_${Date.now()}.md`;
const cr = await client.callTool({
  name: "create_note",
  arguments: { vault: vid, path: tmpName, content: "# 冒烟测试\n\nhello **obsidian**" },
});
assert(cr.structuredContent.saved === true, "create_note 写入成功");
const rd = await client.callTool({ name: "read_note", arguments: { vault: vid, path: tmpName } });
assert(rd.structuredContent.content.includes("hello **obsidian**"), "read_note 读回内容一致");
const wr = await client.callTool({
  name: "write_note",
  arguments: { vault: vid, path: tmpName, content: "# 冒烟测试\n\n已修改", mtime: rd.structuredContent.mtime },
});
assert(wr.structuredContent.saved === true, "write_note 带正确 mtime 保存成功");
// stale mtime must be rejected
await callExpectError(
  "write_note",
  { vault: vid, path: tmpName, content: "覆盖", mtime: 1 },
  /被改动过/
);
// --- create_folder + create note inside it ---
const fs = await import("node:fs/promises");
const vroot = vaults[0].root;
const tmpDir = `.__zcode_panel_smoke_dir_${Date.now()}`;
const cf = await client.callTool({ name: "create_folder", arguments: { vault: vid, path: `${tmpDir}/nested` } });
assert(cf.structuredContent.created === true, "create_folder 多级目录创建成功");
const nested = await client.callTool({
  name: "create_note", arguments: { vault: vid, path: `${tmpDir}/nested/note.md`, content: "in folder" },
});
assert(nested.structuredContent.saved === true, "在新建文件夹下建笔记成功");
// guard: cannot create a folder over an existing file
await callExpectError("create_folder", { vault: vid, path: tmpName }, /同名文件已存在/);

// --- delete_note ---
const toDelName = `.__zcode_panel_smoke_del_${Date.now()}.md`;
await client.callTool({ name: "create_note", arguments: { vault: vid, path: toDelName, content: "to delete" } });
const delRes = await client.callTool({ name: "delete_note", arguments: { vault: vid, path: toDelName } });
assert(delRes.structuredContent.deleted === true, "delete_note 删除成功");
// deleting non-existent note must fail
await callExpectError("delete_note", { vault: vid, path: toDelName }, /不存在/);
// deleting non-md must fail
await callExpectError("delete_note", { vault: vid, path: "something.txt" }, /只能删除/);

await fs.rm(path.join(vroot, tmpDir), { recursive: true, force: true });
await fs.unlink(path.join(vroot, tmpName));
console.log("  cleaned temp note + folder");

// --- drawing round-trip (.excalidraw) ---
const drawName = `__zcode_panel_smoke_draw_${Date.now()}.excalidraw`;
const cd = await client.callTool({ name: "create_drawing", arguments: { vault: vid, path: drawName } });
assert(cd.structuredContent.created === true, "create_drawing 创建画布成功");
const rdw = await client.callTool({ name: "read_drawing", arguments: { vault: vid, path: drawName } });
const scene = JSON.parse(rdw.structuredContent.content);
assert(scene.type === "excalidraw" && Array.isArray(scene.elements), "画布 JSON 结构正确");
scene.elements.push({ id: "test-rect", type: "rectangle", x: 10, y: 10, width: 80, height: 40 });
const wrw = await client.callTool({
  name: "write_drawing",
  arguments: { vault: vid, path: drawName, content: JSON.stringify(scene), mtime: rdw.structuredContent.mtime },
});
assert(wrw.structuredContent.saved === true, "write_drawing 保存成功");
const rdw2 = await client.callTool({ name: "read_drawing", arguments: { vault: vid, path: drawName } });
assert(JSON.parse(rdw2.structuredContent.content).elements.length === 1, "画布元素回读一致");
// drawing must appear in the tree as kind=drawing
const ln2 = await client.callTool({ name: "list_notes", arguments: { vault: vid } });
function findNode(n, p) {
  if (n.path === p) return n;
  for (const c of n.children || []) { const hit = findNode(c, p); if (hit) return hit; }
  return null;
}
const drawNode = findNode(ln2.structuredContent.tree, drawName);
assert(drawNode && drawNode.kind === "drawing", "目录树把 .excalidraw 标记为 drawing");
await client.callTool({ name: "delete_note", arguments: { vault: vid, path: drawName } });
console.log("  cleaned temp drawing");

// --- tree_revision: must bump when the vault changes on disk from outside ---
const r1 = await client.callTool({ name: "tree_revision", arguments: { vault: vid } });
assert(typeof r1.structuredContent.revision === "number", "tree_revision 返回数字版本号");
const watchDir = path.join(vroot, `.__zcode_rev_test_${Date.now()}`);
await fs.mkdir(watchDir, { recursive: true });
await new Promise((r) => setTimeout(r, 900)); // allow debounce to settle
const r2 = await client.callTool({ name: "tree_revision", arguments: { vault: vid } });
assert(r2.structuredContent.revision > r1.structuredContent.revision, "外部改动后版本号递增");
console.log(`  revision ${r1.structuredContent.revision} -> ${r2.structuredContent.revision}`);
await fs.rm(watchDir, { recursive: true, force: true });

// --- search ---
const se = await client.callTool({ name: "search_notes", arguments: { vault: vid, query: "冒烟", limit: 5 } });
assert(Array.isArray(se.structuredContent.results), "search_notes 返回结果数组");

// --- open_vault_panel (model tool) ---
const op = await client.callTool({ name: "open_vault_panel", arguments: {} });
assert(Array.isArray(op.structuredContent.vaults), "open_vault_panel 返回 vault 列表");

await client.close();
console.log("\nALL SMOKE TESTS PASSED");
