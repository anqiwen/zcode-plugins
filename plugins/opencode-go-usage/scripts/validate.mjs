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
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, ".zcode-plugin", "plugin.json"), "utf8"),
  );

  check(/^[a-z0-9][a-z0-9._-]{0,127}$/.test(manifest.name), "插件名不符合 ZCode 命名规则");
  check(Boolean(manifest.version), "缺少 version");
  check(Boolean(manifest.description), "缺少 description");
  check(path.basename(root) === manifest.name, "目录名与插件名不一致");

  const serverNames = Object.keys(manifest.mcpServers ?? {});
  check(serverNames.length === 1, "应只声明一个 MCP 服务");
  const surfaces = manifest.ui?.surfaces ?? [];
  check(surfaces.length > 0, "缺少 ui.surfaces 声明");
  for (const surface of surfaces) {
    check(Boolean(surface.id), "ui.surfaces[].id 缺失");
    check(serverNames.includes(surface.server), `surface ${surface.id} 引用了未声明的服务`);
    check(
      typeof surface.resourceUri === "string" && surface.resourceUri.startsWith("ui://"),
      `surface ${surface.id} 的 resourceUri 必须以 ui:// 开头`,
    );
  }

  for (const file of [
    "dist/server.mjs",
    "dist/cli.mjs",
    "dist/panel.html",
    "dist/dpapi.ps1",
  ]) {
    check(await exists(file), `缺少构建产物：${file}`);
  }

  if (await exists("dist/panel.html")) {
    const html = await fs.readFile(path.join(root, "dist", "panel.html"), "utf8");
    check(!/<script[^>]+src=/i.test(html), "panel.html 引用了外部脚本（应内联）");
    check(!/<link[^>]+href=/i.test(html), "panel.html 引用了外部样式（应内联）");
    check(html.includes("opencode-go-usage"), "panel.html 内容异常");
    check(!html.includes("secrets.dat"), "面板不应包含凭据文件访问逻辑");
    const size = Buffer.byteLength(html);
    check(size < 16 * 1024 * 1024, `panel.html 超过 16 MiB（${size} bytes）`);
    if (size > 8 * 1024 * 1024) warnings.push(`panel.html 较大（${size} bytes）`);
  }

  const server = await fs.readFile(path.join(root, "dist", "server.mjs"), "utf8");
  check(server.includes("ui://opencode-go-usage/panel.html"), "服务端未注册面板资源 URI");
  check(server.includes("text/html;profile=mcp-app"), "服务端未声明 MCP App MIME 类型");
  check(server.includes("https://opencode.ai/zen/go/v1/usage"), "服务端未固定用量接口地址");
  check(server.includes("dpapi.ps1"), "服务端未引用 DPAPI 辅助脚本");
  if (await exists("dist/dpapi.ps1")) {
    const helper = await fs.readFile(path.join(root, "dist", "dpapi.ps1"), "utf8");
    check(helper.includes("ProtectedData"), "DPAPI 辅助脚本缺少 ProtectedData 调用");
    check(helper.includes("CurrentUser"), "DPAPI 辅助脚本未使用 CurrentUser 作用域");
  }

  // The staged marketplace must match the manifest and stay free of dev data.
  const staged = path.join(root, "dist", "local-marketplace");
  if (await exists("dist/local-marketplace/marketplace.json")) {
    const catalog = JSON.parse(
      await fs.readFile(path.join(staged, "marketplace.json"), "utf8"),
    );
    const entry = catalog.plugins?.find((item) => item.name === manifest.name);
    check(Boolean(entry), "本地市场缺少插件条目");
    if (entry) {
      check(entry.version === manifest.version, "本地市场版本与清单不一致");
      check(entry.source === "./plugins/opencode-go-usage", "本地市场 source 路径错误");
    }
    const stagedPlugins = path.join(staged, "plugins", manifest.name);
    for (const forbidden of ["secrets.dat", "accounts.json", "node_modules"]) {
      let present = true;
      try {
        await fs.access(path.join(stagedPlugins, forbidden));
      } catch {
        present = false;
      }
      check(!present, `安装包不应包含 ${forbidden}`);
    }
  } else {
    warnings.push("尚未生成 dist/local-marketplace（先运行 npm run stage）");
  }

  const sizes = [];
  for (const file of ["dist/server.mjs", "dist/cli.mjs", "dist/panel.html"]) {
    if (await exists(file)) {
      const stat = await fs.stat(path.join(root, file));
      sizes.push(`${file}: ${(stat.size / 1024).toFixed(0)} KiB`);
    }
  }

  console.log(`plugin: ${manifest.name}@${manifest.version}`);
  console.log(`surfaces: ${surfaces.map((surface) => surface.id).join(", ")}`);
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
