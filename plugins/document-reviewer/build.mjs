import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const serverOnly = process.argv.includes("--server-only");

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else if (entry.isFile()) await fs.copyFile(src, dst);
  }
}

async function buildServer() {
  await build({
    entryPoints: [path.join(root, "src/server/index.ts")],
    outfile: path.join(dist, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel: "info",
    banner: {
      js: "// document-reviewer MCP server (bundled). Do not edit dist/ by hand.",
    },
  });
}

async function buildUi() {
  const uiDir = path.join(dist, "ui");
  await fs.mkdir(uiDir, { recursive: true });
  const tmpDir = path.join(dist, ".tmp-ui");
  await fs.mkdir(tmpDir, { recursive: true });

  await build({
    entryPoints: [path.join(root, "src/ui/index.tsx")],
    outfile: path.join(tmpDir, "app.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["chrome120", "firefox120", "safari17"],
    jsx: "automatic",
    minify: process.env.UI_MINIFY !== "false",
    sourcemap: false,
    legalComments: "none",
    define: { "process.env.NODE_ENV": '"production"' },
    supported: { "import-meta": false },
    logLevel: "info",
  });

  await build({
    entryPoints: [path.join(root, "src/ui/styles.css")],
    outfile: path.join(tmpDir, "app.css"),
    bundle: true,
    minify: true,
    logLevel: "info",
  });

  const [js, css, template] = await Promise.all([
    fs.readFile(path.join(tmpDir, "app.js"), "utf8"),
    fs.readFile(path.join(tmpDir, "app.css"), "utf8"),
    fs.readFile(path.join(root, "src/ui/index.html"), "utf8"),
  ]);

  const html = template
    .replace("/*__INLINE_CSS__*/", () => css)
    .replace("/*__INLINE_JS__*/", () => js);
  await fs.writeFile(path.join(dist, "panel.html"), html, "utf8");
  await fs.rm(tmpDir, { recursive: true, force: true });

  // pdf.js worker: served through ui://document-reviewer/assets/pdf-worker.js
  const worker = path.join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
  await fs.copyFile(worker, path.join(dist, "pdf-worker.js"));

  // CMaps, standard fonts and wasm used by pdf.js for CJK PDFs and image codecs.
  const pdfjs = path.join(root, "node_modules/pdfjs-dist");
  await copyDir(path.join(pdfjs, "cmaps"), path.join(dist, "pdfjs/cmaps"));
  await copyDir(path.join(pdfjs, "standard_fonts"), path.join(dist, "pdfjs/standard_fonts"));
  await copyDir(path.join(pdfjs, "wasm"), path.join(dist, "pdfjs/wasm"));

  const bytes = (await fs.stat(path.join(dist, "panel.html"))).size;
  console.log(`panel.html ${(bytes / 1024 / 1024).toFixed(2)} MiB`);
}

async function main() {
  await fs.mkdir(dist, { recursive: true });
  await buildServer();
  if (!serverOnly) await buildUi();
  console.log("build complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
