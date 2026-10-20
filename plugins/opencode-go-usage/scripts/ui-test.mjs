#!/usr/bin/env node
/**
 * Headless UI test for the panel, driven over the Chrome DevTools Protocol.
 *
 *   node scripts/ui-test.mjs [mainUrl] [emptyUrl] [lightUrl]
 *
 * Defaults assume three mock hosts:
 *   8793 dark/zh with .test-data
 *   8794 dark/zh with an empty data dir
 *   8795 light/en with .test-data
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const mainUrl = process.argv[2] || "http://127.0.0.1:8793/";
const emptyUrl = process.argv[3] || "http://127.0.0.1:8794/";
const lightUrl = process.argv[4] || "http://127.0.0.1:8795/";
const port = 9223;

const candidates = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
let chromePath = "";
for (const candidate of candidates) {
  try {
    await fs.access(candidate);
    chromePath = candidate;
    break;
  } catch {
    /* try the next one */
  }
}
if (!chromePath) throw new Error("Chrome/Edge not found; set CHROME_PATH");

const profile = await fs.mkdtemp(path.join(os.tmpdir(), "ocg-ui-"));
const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--disable-extensions",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1180,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function waitForDevtools() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Chrome DevTools endpoint did not start");
}

await waitForDevtools();
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
const errors = [];
ws.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === "Runtime.exceptionThrown") {
    errors.push(message.params.exceptionDetails?.text ?? "exception");
  }
  if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
    errors.push(message.params.entry.text);
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluate failed",
    );
  }
  return result.result.value;
}

const PANEL = `document.querySelector('iframe')?.contentDocument`;

async function panelText() {
  return evaluate(`(${PANEL}?.body?.innerText) || ''`);
}

async function waitForText(needle, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = await panelText();
    if (text.includes(needle)) return text;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for panel text: ${needle}`);
}

async function clickButton(label) {
  const clicked = await evaluate(`(() => {
    const doc = ${PANEL};
    if (!doc) return 'no-frame';
    const button = [...doc.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return 'not-found';
    button.click();
    return 'clicked';
  })()`);
  assert.equal(clicked, "clicked", `button not found: ${label}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function screenshot(file) {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await fs.writeFile(file, Buffer.from(shot.data, "base64"));
  console.log("screenshot:", file);
}

async function navigate(url, readyText) {
  await send("Page.navigate", { url });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const doc = await evaluate("document.readyState");
    if (doc === "complete") break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await waitForText(readyText);
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  // ---------------------------------------------------------------- main
  await navigate(mainUrl, "5 小时");
  let text = await panelText();
  assert.ok(text.includes("OpenCode Go 用量"), "Chinese header missing");
  assert.ok(text.includes("5 小时"), "5-hour window missing");
  assert.ok(text.includes("每周"), "weekly window missing");
  assert.ok(text.includes("每月"), "monthly window missing");
  assert.ok(text.includes("重置于"), "countdown missing");
  assert.ok(text.includes("额度预警"), "warning banner missing");
  assert.ok(text.includes("Windows DPAPI"), "credential backend missing");
  console.log("main render: PASS");

  // ------------------------------------------------------------ settings
  await clickButton("设置");
  text = await panelText();
  assert.ok(text.includes("面板设置"), "settings sheet missing");
  assert.ok(text.includes("预警阈值"), "warning threshold missing");
  const changed = await evaluate(`(() => {
    const doc = ${PANEL};
    const selects = doc.querySelectorAll('select');
    const inputs = doc.querySelectorAll('input[type=number]');
    selects[0].value = '300';
    inputs[0].value = '80';
    inputs[1].value = '95';
    selects[1].value = 'en-US';
    return { selects: selects.length, inputs: inputs.length };
  })()`);
  assert.equal(changed.selects, 2);
  assert.equal(changed.inputs, 2);
  await clickButton("保存设置");
  await waitForText("OpenCode Go Usage");
  text = await panelText();
  assert.ok(text.includes("Auto-refresh"), "language switch to English failed");
  assert.ok(text.includes("Quota warning"), "English warning banner missing");
  console.log("settings + i18n: PASS");

  // switch back to Chinese/auto
  await clickButton("Settings");
  await evaluate(`(() => {
    const doc = ${PANEL};
    const selects = doc.querySelectorAll('select');
    selects[0].value = '300';
    selects[1].value = 'auto';
  })()`);
  await clickButton("Save settings");
  await waitForText("OpenCode Go 用量");
  console.log("language auto: PASS");

  // ----------------------------------------------------------- add sheet
  await clickButton("添加账号");
  text = await panelText();
  assert.ok(text.includes("在终端运行"), "add instructions missing");
  assert.ok(text.includes("cli.mjs"), "CLI path missing");
  assert.ok(text.includes("--data-dir"), "data dir flag missing");
  await clickButton("关闭");
  console.log("add sheet: PASS");

  // -------------------------------------------------------------- rename
  await clickButton("改名");
  await evaluate(`(() => {
    const doc = ${PANEL};
    const input = doc.querySelector('.rename-input');
    input.value = '主号（UI 测试）';
  })()`);
  await clickButton("保存");
  await waitForText("主号（UI 测试）");
  await clickButton("改名");
  await evaluate(`(() => {
    const doc = ${PANEL};
    doc.querySelector('.rename-input').value = '主号（163）';
  })()`);
  await clickButton("保存");
  await waitForText("主号（163）");
  console.log("rename: PASS");

  // -------------------------------------------------------- enable/disable
  await clickButton("停用");
  text = await waitForText("已停用");
  assert.ok(!text.includes("重置于"), "windows still rendered while disabled");
  await clickButton("启用");
  await waitForText("重置于");
  console.log("enable/disable: PASS");

  // -------------------------------------------------------------- refresh
  await clickButton("刷新");
  await waitForText("5 小时");
  assert.ok(!(await panelText()).includes("操作失败"), "refresh surfaced an action error");
  console.log("manual refresh: PASS");

  await screenshot(path.join(process.cwd(), "ui-main.png"));

  // --------------------------------------------------------------- empty
  await navigate(emptyUrl, "还没有 OpenCode Go 账号");
  text = await panelText();
  assert.ok(text.includes("还没有 OpenCode Go 账号"), "empty state missing");
  assert.ok(text.includes("cli.mjs"), "empty state command missing");
  await screenshot(path.join(process.cwd(), "ui-empty.png"));
  console.log("empty state: PASS");

  // ----------------------------------------------------------- light / en
  await navigate(lightUrl, "Quota warning");
  text = await panelText();
  assert.ok(text.includes("OpenCode Go Usage"), "English header missing on light host");
  assert.ok(text.includes("5h"), "English window labels missing");
  await screenshot(path.join(process.cwd(), "ui-light-en.png"));
  console.log("light + English: PASS");

  assert.deepEqual(errors, [], `console errors: ${errors.join(" | ")}`);
  console.log("ui-test: PASS");
} finally {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill();
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}
