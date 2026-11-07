/**
 * 回归测试：预览 token 必须指向不可变快照，且解释器缺失时不能把 server 带崩。
 *
 *   node tests/preview-snapshot.mjs
 *
 * 背景（0.1.2 修的三处）：
 *   1. 同一脚本每次重画写同一个输出文件，token 若只记路径，后一次渲染会改掉前一个 URI 的内容；
 *   2. 多个 server 进程共用 .preview，会互相覆盖；
 *   3. spawn 失败只发 error 事件，没有监听就会崩掉整个 MCP server。
 */

import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WORKSPACE = ROOT;
const SERVER = path.join(ROOT, "dist", "server.mjs");

function startServer(env = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: WORKSPACE, ZCODE_PLUGIN_ROOT: ROOT, ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let id = 1;
  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
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
  const rpc = (method, params = {}) => {
    const myId = id++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(myId);
        reject(new Error(`${method} 超时`));
      }, 90000);
      pending.set(myId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  };
  const notify = (method, params = {}) =>
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { proc, rpc, notify };
}

function pngSize(base64) {
  const bytes = Buffer.from(base64, "base64");
  return { bytes, w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

const steps = [];
const check = (name, fn) => steps.push([name, fn]);

const a = startServer();
let uriA = null;
let bytesA = null;

check("握手", async () => {
  const r = await a.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "preview-snapshot", version: "1" },
  });
  a.notify("notifications/initialized");
  return `${r.serverInfo?.name} ${r.serverInfo?.version}`;
});

check("渲染第一版（7.0×3.6）", async () => {
  const r = await a.rpc("tools/call", {
    name: "render_preview",
    arguments: {
      script: "examples/demo.py",
      overrides: { "figure.figsize": [7.0, 3.6], "savefig.bbox_inches": null },
    },
  });
  uriA = r.structuredContent.data.previewUri;
  const res = await a.rpc("resources/read", { uri: uriA });
  const { bytes, w, h } = pngSize(res.contents[0].blob);
  bytesA = bytes;
  if (Math.abs(w - 700) > 2 || Math.abs(h - 360) > 2) throw new Error(`尺寸 ${w}×${h}`);
  return `${w}×${h}，${bytes.length} B`;
});

check("再渲染第二版（3.2×1.8，模拟原图）", async () => {
  const r = await a.rpc("tools/call", {
    name: "render_preview",
    arguments: {
      script: "examples/demo.py",
      overrides: { "figure.figsize": [3.2, 1.8], "savefig.bbox_inches": null },
    },
  });
  const res = await a.rpc("resources/read", { uri: r.structuredContent.data.previewUri });
  const { w, h } = pngSize(res.contents[0].blob);
  if (Math.abs(w - 320) > 2 || Math.abs(h - 180) > 2) throw new Error(`尺寸 ${w}×${h}`);
  return `${w}×${h}`;
});

check("旧 URI 内容没被覆盖", async () => {
  const res = await a.rpc("resources/read", { uri: uriA });
  const { bytes, w, h } = pngSize(res.contents[0].blob);
  if (Math.abs(w - 700) > 2 || Math.abs(h - 360) > 2) {
    throw new Error(`旧 URI 变成了 ${w}×${h}——预览文件被后来的渲染覆盖了`);
  }
  if (!bytes.equals(bytesA)) throw new Error("旧 URI 的字节和第一次读到的不同");
  return "字节一致，仍是 700×360";
});

check("每个进程独立预览目录", async () => {
  const { promises: fs } = await import("node:fs");
  const base = path.join(ROOT, ".preview");
  const dirs = await fs.readdir(base).catch(() => []);
  const mine = `p${a.proc.pid}`;
  if (!dirs.includes(mine)) throw new Error(`没有 ${mine}，实际：${dirs.join(", ")}`);
  return `${mine}（共 ${dirs.length} 个进程目录）`;
});

check("解释器不存在时只报错不崩溃", async () => {
  const bad = startServer({ FIGSTUDIO_PYTHON: "__definitely_not_python__" });
  try {
    const init = await bad.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "bad-python", version: "1" },
    });
    if (!init.serverInfo) throw new Error("握手失败");
    bad.notify("notifications/initialized");
    const r = await bad.rpc("tools/call", {
      name: "inspect_script",
      arguments: { script: "examples/demo.py" },
    });
    const sc = r.structuredContent;
    if (sc?.ok !== false) throw new Error("坏解释器居然成功了");
    if (!/Python 环境不可用|解释器/.test(sc.error.message)) {
      throw new Error(`错误信息不可读：${sc.error.message}`);
    }
    // 进程还活着：再 ping 一次
    await bad.rpc("ping");
    return sc.error.message.slice(0, 44);
  } finally {
    bad.proc.kill();
  }
});

let failed = 0;
for (const [name, fn] of steps) {
  try {
    const info = await fn();
    console.log(`  OK   ${name.padEnd(18)} ${info ?? ""}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name.padEnd(18)} ${e.message}`);
  }
}

console.log(failed ? `\n${failed} 步失败` : "\n全部通过");
a.proc.kill();
process.exit(failed ? 1 : 0);
