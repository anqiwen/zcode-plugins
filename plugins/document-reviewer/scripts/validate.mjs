import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const errors = [];
const warnings = [];

function check(condition, message) {
  if (!condition) errors.push(message);
}

async function exists(relative) {
  try {
    await fs.access(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const manifestPath = path.join(root, ".zcode-plugin", "plugin.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

  check(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(manifest.name), "插件名不符合 ZCode 命名规则");
  check(Boolean(manifest.version), "缺少 version");
  check(Boolean(manifest.description), "缺少 description");

  const serverNames = Object.keys(manifest.mcpServers ?? {});
  check(serverNames.length === 1, "应只声明一个 MCP 服务");

  for (const surface of manifest.ui?.surfaces ?? []) {
    check(Boolean(surface.id), "ui.surfaces[].id 缺失");
    check(Boolean(surface.server), `surface ${surface.id} 缺少 server`);
    check(serverNames.includes(surface.server), `surface ${surface.id} 引用了未声明的服务`);
    check(
      typeof surface.resourceUri === "string" && surface.resourceUri.startsWith("ui://"),
      `surface ${surface.id} 的 resourceUri 必须以 ui:// 开头`,
    );
  }
  check((manifest.ui?.surfaces ?? []).length > 0, "缺少 ui.surfaces 声明");

  for (const file of [
    "dist/server.mjs",
    "dist/panel.html",
    "dist/pdf-worker.js",
    "dist/pdfjs/cmaps",
    "dist/pdfjs/standard_fonts",
    "dist/pdfjs/wasm",
  ]) {
    check(await exists(file), `缺少构建产物：${file}`);
  }

  if (await exists("dist/panel.html")) {
    const html = await fs.readFile(path.join(root, "dist/panel.html"), "utf8");
    check(!/<script[^>]+src=/i.test(html), "panel.html 引用了外部脚本（应内联）");
    check(!/<link[^>]+href=/i.test(html), "panel.html 引用了外部样式（应内联）");
    check(html.includes("ui/") || html.includes("document-reviewer"), "panel.html 内容异常");
    const size = Buffer.byteLength(html);
    check(size < 16 * 1024 * 1024, `panel.html 超过 16 MiB（${size} bytes）`);
    if (size > 8 * 1024 * 1024) warnings.push(`panel.html 较大（${size} bytes）`);
  }

  const server = await fs.readFile(path.join(root, "dist/server.mjs"), "utf8");
  check(server.includes("ui://document-reviewer/panel.html"), "服务端未注册面板资源 URI");
  check(server.includes("text/html;profile=mcp-app"), "服务端未声明 MCP App MIME 类型");
  check(server.includes("ZCODE_WORKSPACE_ROOT"), "服务端未读取工作区根目录");

  const sizes = [];
  for (const file of ["dist/server.mjs", "dist/panel.html", "dist/pdf-worker.js"]) {
    if (await exists(file)) {
      const stat = await fs.stat(path.join(root, file));
      sizes.push(`${file}: ${(stat.size / 1024).toFixed(0)} KiB`);
    }
  }

  console.log(`plugin: ${manifest.name}@${manifest.version}`);
  console.log(`surfaces: ${(manifest.ui?.surfaces ?? []).map((s) => s.id).join(", ")}`);
  sizes.forEach((line) => console.log(line));
  warnings.forEach((warning) => console.log(`WARN ${warning}`));

  if (errors.length > 0) {
    console.error(`\n${errors.length} 个问题：`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exit(1);
  }
  console.log("validate: OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
