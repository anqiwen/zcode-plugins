/**
 * 把 UI 打成一个自包含的 panel.html。
 *
 * ZCode 的插件面板不允许引用外部脚本/样式（validate 会拦截 <script src=>），
 * 所以 JS 与 CSS 必须内联进 HTML。
 */

import * as esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 不能用 new URL().pathname：中文路径会被百分号编码
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const TMP = path.join(DIST, ".tmp-ui");

await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(TMP, { recursive: true });

// 前端 JS：ext-apps 桥 + 面板逻辑
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/ui/app.js")],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["chrome120", "firefox120", "safari17"],
  outfile: path.join(TMP, "app.js"),
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  supported: { "import-meta": false },
  logLevel: "info",
});

// MCP server：把 sdk/zod 一起打进去，安装时就不必复制 node_modules
await esbuild.build({
  entryPoints: [path.join(ROOT, "server.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: path.join(DIST, "server.mjs"),
  minify: false,
  sourcemap: false,
  banner: { js: "// 由 build.mjs 生成，不要手改；源码在插件根的 server.mjs" },
  logLevel: "info",
});

// 样式
await esbuild.build({
  entryPoints: [path.join(ROOT, "src/ui/styles.css")],
  bundle: true,
  outfile: path.join(TMP, "app.css"),
  minify: true,
  logLevel: "info",
});

const [js, css, template] = await Promise.all([
  fs.readFile(path.join(TMP, "app.js"), "utf8"),
  fs.readFile(path.join(TMP, "app.css"), "utf8"),
  fs.readFile(path.join(ROOT, "src/ui/index.html"), "utf8"),
]);

const html = template
  .replace("/*__INLINE_CSS__*/", () => css)
  .replace("/*__INLINE_JS__*/", () => js);

await fs.writeFile(path.join(DIST, "panel.html"), html, "utf8");
await fs.rm(TMP, { recursive: true, force: true });

const bytes = Buffer.byteLength(html, "utf8");
if (bytes > 16 * 1024 * 1024) {
  throw new Error(`panel.html 超过 16 MiB 上限：${bytes} bytes`);
}
console.log(`dist/panel.html  ${(bytes / 1024).toFixed(1)} KiB`);
