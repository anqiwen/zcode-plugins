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
  });
  const js = ui.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
  const tpl = await fs.readFile(path.join(ROOT, "src", "ui", "template.html"), "utf8");
  // IMPORTANT: use a replacer function. A plain replacement string would interpret
  // "$&", "$`", "$'" sequences that occur inside the minified zod regexes and
  // inject the surrounding template HTML into the JS, breaking the syntax.
  const html = tpl.replace("/*__APP_BUNDLE__*/", () => js);
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
