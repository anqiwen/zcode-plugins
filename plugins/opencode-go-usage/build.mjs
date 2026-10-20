import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");

async function buildNode(entry, outfile, banner) {
  await build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(dist, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: false,
    minify: false,
    legalComments: "none",
    logLevel: "info",
    banner: {
      // undici is CommonJS and calls require() for node builtins; give the
      // bundled ESM output a real require instead of esbuild's throwing stub.
      js: [
        'import { createRequire as __createRequire } from "node:module";',
        "const require = __createRequire(import.meta.url);",
        banner,
      ].join("\n"),
    },
  });
}

async function buildUi() {
  const tmpDir = path.join(dist, ".tmp-ui");
  await fs.mkdir(tmpDir, { recursive: true });

  await build({
    entryPoints: [path.join(root, "src/ui/index.ts")],
    outfile: path.join(tmpDir, "app.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    target: ["chrome120", "firefox120", "safari17"],
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

  const bytes = (await fs.stat(path.join(dist, "panel.html"))).size;
  console.log(`panel.html ${(bytes / 1024).toFixed(1)} KiB`);
}

async function main() {
  await fs.mkdir(dist, { recursive: true });
  await Promise.all([
    buildNode(
      "src/server/index.ts",
      "server.mjs",
      "// opencode-go-usage MCP server (bundled). Do not edit dist/ by hand.",
    ),
    buildNode(
      "src/cli.ts",
      "cli.mjs",
      "// opencode-go-usage CLI (bundled). Do not edit dist/ by hand.",
    ),
    buildUi(),
  ]);
  await fs.copyFile(
    path.join(root, "src/server/dpapi.ps1"),
    path.join(dist, "dpapi.ps1"),
  );
  console.log("build complete");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
