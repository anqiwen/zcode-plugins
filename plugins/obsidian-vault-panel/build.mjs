// Bundle server + UI into the installable plugin directory (dist/).
// - server.mjs: bundled with the MCP SDK, so runtime needs zero node_modules.
// - ui/panel.html: single self-contained HTML (all CSS/JS inlined) for the sandbox CSP.
import esbuild from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const UI = path.join(DIST, "ui");
const STAGE = path.join(ROOT, "marketplace", "plugins", "obsidian-vault-panel");

// Excalidraw statically bundles two optional, lazy-imported extras:
//   * mermaid -> @excalidraw/mermaid-to-excalidraw (pulls mermaid + cytoscape ~2.7 MB)
//   * 55 UI locales (~1.6 MB)
// Both are only reached on user action (paste Mermaid text / switch language).
// Stubbing them keeps the panel under the host's 8 MiB per-resource-read limit.
const trimPlugin = {
  name: "trim-excalidraw-optionals",
  setup(build) {
    // "mermaid" is the safe default: the locale map must stay intact or
    // Excalidraw fails at init ("t8 is not a function").
    const mode = process.env.OVP_STUB || "mermaid"; // both | mermaid | locale | none
    const stubMermaid = mode === "both" || mode === "mermaid";
    const stubLocale = mode === "both" || mode === "locale";
    const stub = (contents) => ({ contents, loader: "js", resolveDir: ROOT });
    if (stubMermaid) {
      build.onResolve({ filter: /^@excalidraw\/mermaid-to-excalidraw$/ }, () => ({ path: "mermaid-stub", namespace: "ovp-stub" }));
      build.onResolve({ filter: /^mermaid$/ }, () => ({ path: "mermaid-stub", namespace: "ovp-stub" }));
    }
    if (stubLocale) {
      build.onResolve({ filter: /\/locales\/[^/]+\.js$/ }, () => ({ path: "locale-stub", namespace: "ovp-stub" }));
    }
    build.onLoad({ filter: /.*/, namespace: "ovp-stub" }, (args) => {
      if (args.path === "locale-stub") return stub("export default {};");
      // Mermaid conversion is unavailable in this build; fail with a clear message
      // only if the user actually triggers it.
      return stub(
        `export async function parseMermaidToExcalidraw(){ throw new Error("Mermaid 转图形在本插件中已裁剪，请改用官方 Excalidraw 插件或手动绘制"); }
export default { parseMermaidToExcalidraw };`
      );
    });
  },
};

async function main() {
  await fs.mkdir(UI, { recursive: true });

  // 1) Server bundle (externalize nothing; node builtins stay external automatically).
  await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "server.mjs")],
    outfile: path.join(DIST, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "warning",
  });

  // 2) UI bundle (browser, IIFE, minified).
  const ui = await esbuild.build({
    entryPoints: [path.join(ROOT, "src", "ui", "app.js")],
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    minify: true,
    write: false,
    logLevel: "warning",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [trimPlugin],
    loader: {
      ".woff2": "dataurl",
      ".woff": "dataurl",
      ".ttf": "dataurl",
      ".png": "dataurl",
      ".svg": "dataurl",
    },
  });
  // esbuild with write:false reports "<stdout>" paths, so pick by extension
  // rather than by ".js" suffix.
  const uiCss = ui.outputFiles.find((f) => f.path.endsWith(".css"));
  const jsOut = ui.outputFiles.find((f) => !f.path.endsWith(".css"));
  const js = jsOut.text.replace(/<\/script/gi, "<\\/script");

  // 3) Excalidraw stylesheet (fonts inlined as data URLs so the sandbox CSP
  //    never needs a network origin).
  const cssBuild = await esbuild.build({
    // Point at the installed file directly: the package's exports map routes
    // "./index.css" through development/production conditions that esbuild
    // won't pick up from a bare @import.
    entryPoints: [
      path.join(ROOT, "node_modules", "@excalidraw", "excalidraw", "dist", "prod", "index.css"),
    ],
    bundle: true,
    write: false,
    logLevel: "warning",
    loader: {
      ".woff2": "dataurl",
      ".woff": "dataurl",
      ".ttf": "dataurl",
      ".png": "dataurl",
      ".svg": "dataurl",
    },
  });
  const drawCss = cssBuild.outputFiles[0].text.replace(/<\/style/gi, "<\\/style");

  const tpl = await fs.readFile(path.join(ROOT, "src", "ui", "template.html"), "utf8");
  // IMPORTANT: use replacer functions. A plain replacement string would
  // interpret "$&", "$`", "$'" sequences in the minified code/CSS.
  let html = tpl.replace("/*__DRAW_CSS__*/", () => drawCss);
  html = html.replace("/*__APP_BUNDLE__*/", () => js);
  if (uiCss) {
    // Any CSS esbuild extracted from the JS graph (currently none, but keep it
    // safe if a dependency starts importing .css directly).
    html = html.replace("</style>", () => uiCss.text + "\n</style>");
  }
  await fs.writeFile(path.join(UI, "panel.html"), html, "utf8");

  // 3) Stage the installable plugin into the local marketplace dir.
  await fs.mkdir(path.join(STAGE, ".zcode-plugin"), { recursive: true });
  await fs.mkdir(path.join(STAGE, "dist", "ui"), { recursive: true });
  await fs.copyFile(path.join(DIST, "server.mjs"), path.join(STAGE, "dist", "server.mjs"));
  await fs.copyFile(path.join(UI, "panel.html"), path.join(STAGE, "dist", "ui", "panel.html"));
  await fs.copyFile(
    path.join(ROOT, "src", "plugin.json"),
    path.join(STAGE, ".zcode-plugin", "plugin.json")
  );

  const sz = (p) => fs.stat(p).then((s) => (s.size / 1024).toFixed(1) + " KB");
  console.log("✓ dist/server.mjs        ", await sz(path.join(DIST, "server.mjs")));
  console.log("✓ dist/ui/panel.html     ", await sz(path.join(UI, "panel.html")));
  console.log("✓ staged marketplace     ", STAGE);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
