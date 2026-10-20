import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "dist", "local-marketplace");
const pluginOut = path.join(out, "plugins", "document-reviewer");

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else if (entry.isFile()) await fs.copyFile(src, dst);
  }
}

async function iconDataUri() {
  try {
    const data = await fs.readFile(path.join(root, "assets", "icon.png"));
    return { icon: `data:image/png;base64,${data.toString("base64")}` };
  } catch {
    return {};
  }
}

async function main() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(pluginOut, { recursive: true });

  for (const file of [".zcode-plugin", "skills"]) {
    await copyDir(path.join(root, file), path.join(pluginOut, file));
  }
  await fs.mkdir(path.join(pluginOut, "dist"), { recursive: true });
  for (const file of ["server.mjs", "panel.html", "pdf-worker.js"]) {
    await fs.copyFile(path.join(root, "dist", file), path.join(pluginOut, "dist", file));
  }
  await copyDir(path.join(root, "dist", "pdfjs"), path.join(pluginOut, "dist", "pdfjs"));
  for (const file of ["README.md", "LICENSE"]) {
    try {
      await fs.copyFile(path.join(root, file), path.join(pluginOut, file));
    } catch {
      /* optional */
    }
  }

  const marketplace = {
    name: "document-reviewer-local",
    description: "Local development marketplace for the Document Reviewer ZCode plugin.",
    plugins: [
      {
        name: manifest.name,
        source: "./plugins/document-reviewer",
        description: manifest.description,
        version: manifest.version,
        category: "productivity",
        tags: ["document", "review", "annotation"],
        ...(await iconDataUri()),
      },
    ],
  };
  await fs.writeFile(
    path.join(out, "marketplace.json"),
    JSON.stringify(marketplace, null, 2),
    "utf8",
  );
  console.log(`staged marketplace: ${out}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
