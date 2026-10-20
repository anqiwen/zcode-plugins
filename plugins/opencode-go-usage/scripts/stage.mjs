import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const out = path.join(root, "dist", "local-marketplace");
const pluginOut = path.join(out, "plugins", "opencode-go-usage");

async function copyDir(from, to) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) await copyDir(src, dst);
    else if (entry.isFile()) await fs.copyFile(src, dst);
  }
}

async function copyOptional(relative) {
  try {
    await fs.copyFile(path.join(root, relative), path.join(pluginOut, relative));
  } catch {
    /* optional file */
  }
}

async function main() {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, ".zcode-plugin", "plugin.json"), "utf8"),
  );

  // The installed copy must contain only runtime files: no node_modules, no
  // dev data, no screenshots and no encrypted test credentials.
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(path.join(pluginOut, "dist"), { recursive: true });
  await copyDir(
    path.join(root, ".zcode-plugin"),
    path.join(pluginOut, ".zcode-plugin"),
  );
  for (const file of ["server.mjs", "cli.mjs", "panel.html", "dpapi.ps1"]) {
    await fs.copyFile(
      path.join(root, "dist", file),
      path.join(pluginOut, "dist", file),
    );
  }
  for (const file of ["README.md", "LICENSE"]) {
    await copyOptional(file);
  }

  const marketplace = {
    name: "opencode-go-usage-local",
    description:
      "Local development marketplace for the OpenCode Go Usage ZCode plugin.",
    plugins: [
      {
        name: manifest.name,
        source: "./plugins/opencode-go-usage",
        version: manifest.version,
        description: manifest.description,
        displayName: "OpenCode Go Usage",
        displayName_i18n: { "zh-CN": "OpenCode Go 用量", "en-US": "OpenCode Go Usage" },
        description_i18n: manifest.description_i18n,
        category: "productivity",
        tags: ["opencode", "quota", "usage", "subscription"],
      },
    ],
  };
  await fs.writeFile(
    path.join(out, "marketplace.json"),
    `${JSON.stringify(marketplace, null, 2)}\n`,
    "utf8",
  );
  console.log(`staged marketplace: ${out}`);
  console.log(`plugin: ${manifest.name}@${manifest.version}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
