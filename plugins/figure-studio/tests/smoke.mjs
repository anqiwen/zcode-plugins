/**
 * 端到端冒烟测试：不起 ZCode，直接用 stdio 走一遍完整链路。
 *
 *   node tests/smoke.mjs
 *
 * 覆盖：握手 → 列工具 → 扫脚本 → 读参数 → 重画 → 预览改动。
 * 任何一步失败都会以非零码退出。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = ROOT; // 把示例目录当工作区

// 测 dist/ 里的打包产物，而不是源码：安装后跑的是这一份
const server = spawn(process.execPath, [path.join(ROOT, "dist", "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, ZCODE_WORKSPACE_ROOT: WORKSPACE, ZCODE_PLUGIN_ROOT: ROOT },
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let id = 1;

readline.createInterface({ input: server.stdout }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
});

function rpc(method, params = {}) {
  const myId = id++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(myId);
      reject(new Error(`${method} 超时`));
    }, 90000);
    pending.set(myId, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
  });
}

function notify(method, params = {}) {
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

const steps = [];
function check(name, fn) {
  steps.push([name, fn]);
}

let tools = [];
let previewUri = null;

check("握手", async () => {
  const r = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1" },
  });
  notify("notifications/initialized");
  if (r.serverInfo?.name !== "figure-studio") throw new Error("serverInfo 不对");
  return `${r.serverInfo.name} ${r.serverInfo.version}`;
});

check("列出工具", async () => {
  const r = await rpc("tools/list");
  tools = r.tools.map((t) => t.name);
  const want = ["inspect_script", "render_preview", "plan_rewrite", "apply_rewrite", "list_scripts"];
  const missing = want.filter((w) => !tools.includes(w));
  if (missing.length) throw new Error(`缺工具：${missing}`);
  return `${tools.length} 个：${tools.join(", ")}`;
});

check("扫描脚本", async () => {
  const r = await rpc("tools/call", { name: "list_scripts", arguments: { limit: 200 } });
  const data = r.structuredContent.data;
  if (!data.scripts.some((s) => s.endsWith("demo.py"))) {
    throw new Error(`没找到 examples/demo.py，实际：${data.scripts.slice(0, 5)}`);
  }
  return `${data.scripts.length} 个 .py`;
});

check("读取参数", async () => {
  const r = await rpc("tools/call", {
    name: "inspect_script",
    arguments: { script: "examples/demo.py" },
  });
  const data = r.structuredContent.data;
  const keys = data.records.map((x) => `${x.scope}.${x.key}`);
  for (const need of ["figure.figsize", "legend.fontsize", "axes.set_ylabel.fontsize"]) {
    if (!keys.includes(need)) throw new Error(`没抓到 ${need}`);
  }
  return `${data.records.length} 个参数，脚本 ${data.elapsed_ms} ms`;
});

check("重画", async () => {
  const r = await rpc("tools/call", {
    name: "render_preview",
    arguments: {
      script: "examples/demo.py",
      overrides: {
        "figure.figsize": [7.0, 3.6],
        "axes.set_ylabel.fontsize": 12.5,
        "legend.fontsize": 11.0,
        "savefig.bbox_inches": null,
      },
    },
  });
  const data = r.structuredContent.data;
  previewUri = data.previewUri;
  if (!previewUri) throw new Error("没有返回 previewUri");
  // 覆盖是否生效看产物尺寸（records 记的是脚本原值，不是生效值）
  return `${data.elapsed_ms} ms`;
});

check("读取预览资源", async () => {
  const r = await rpc("resources/read", { uri: previewUri });
  const blob = r.contents?.[0]?.blob;
  if (!blob || blob.length < 1000) throw new Error("预览图太小或为空");
  const bytes = Buffer.from(blob, "base64");
  // PNG: 8 字节签名 + 4 长度 + 4 "IHDR" + 4 宽 + 4 高
  const w = bytes.readUInt32BE(16);
  const h = bytes.readUInt32BE(20);
  // 7.0×3.6 in @100 dpi = 700×360；若 tight 未关掉会偏小
  if (Math.abs(w - 700) > 2 || Math.abs(h - 360) > 2) {
    throw new Error(`尺寸 ${w}×${h}，期望 700×360（figsize 与 bbox_inches 覆盖没生效）`);
  }
  return `${w}×${h} px，${(blob.length / 1024).toFixed(0)} KiB base64`;
});

check("版面体检", async () => {
  const r = await rpc("tools/call", {
    name: "render_preview",
    arguments: {
      script: "examples/demo.py",
      overrides: {
        "figure.figsize": [3.2, 1.8],
        "axes.set_ylabel.fontsize": 26.0,
        "axes.set_title.fontsize": 26.0,
        "legend.fontsize": 18.0,
      },
    },
  });
  const d = r.structuredContent.data;
  if (!d.warnings?.length) throw new Error("字号拉到 26 却没触发溢出告警");
  return `${d.warnings.length} 处 / ${d.warning_summary.slice(0, 30)}`;
});

check("预览改动", async () => {
  const r = await rpc("tools/call", {
    name: "plan_rewrite",
    arguments: {
      script: "examples/demo.py",
      overrides: { "axes.set_ylabel.fontsize": 12.5, "figure.figsize": [7.0, 3.6] },
    },
  });
  const data = r.structuredContent.data;
  if (!data.diff.includes("12.5")) throw new Error("diff 里没有新字号");
  return `改 ${data.applied.length} 项，跳过 ${data.skipped.length} 项`;
});

let failed = 0;
for (const [name, fn] of steps) {
  try {
    const info = await fn();
    console.log(`  OK   ${name.padEnd(14)} ${info ?? ""}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name.padEnd(14)} ${e.message}`);
  }
}

console.log(failed ? `\n${failed} 步失败` : "\n全部通过");
server.kill();
process.exit(failed ? 1 : 0);
