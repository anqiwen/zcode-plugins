#!/usr/bin/env node
/**
 * Minimal MCP Apps host for local UI verification.
 *
 *   node scripts/mock-host.mjs
 *
 * It serves the built panel in an iframe, speaks JSON-RPC with it, and proxies
 * tools/call + resources/read to the real MCP server over stdio. This exercises
 * the real panel bundle and the real server; only the ZCode desktop shell is
 * replaced.
 */
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pluginData = path.resolve(
  process.env.MOCK_DATA ||
    path.join(root, "..", "..", ".opencode-go-usage-dev", "data"),
);
const port = Number(process.env.MOCK_PORT || 8793);
const inlineMode = process.env.MOCK_INLINE === "1";
const noMessage = process.env.MOCK_NO_MESSAGE === "1";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "dist", "server.mjs")],
  env: {
    ...process.env,
    ZCODE_PLUGIN_DATA: pluginData,
    OPENCODE_GO_USAGE_DATA: pluginData,
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

const client = new Client({ name: "mock-host", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

const hostCapabilities = {
  openLinks: {},
  serverTools: {},
  serverResources: { listChanged: false },
  logging: {},
  ...(noMessage ? {} : { message: { text: {}, image: {} } }),
  updateModelContext: { text: {}, structuredContent: {}, image: {} },
  downloadFile: {},
  experimental: {
    "zcode/widgetState": {},
    "zcode/resourceSubscribe": {},
    "zcode/surface": { id: "usage" },
  },
};

const hostContext = {
  theme: process.env.MOCK_THEME || "dark",
  locale: process.env.MOCK_LOCALE || "zh-CN",
  displayMode: inlineMode ? "inline" : "fullscreen",
  availableDisplayModes: ["inline", "fullscreen"],
  containerDimensions: { width: 1200, height: 900 },
};

const HOST_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock ZCode host — OpenCode Go Usage</title>
<style>
  html,body{margin:0;height:100%;background:#0f1116;color:#e8eaf0;font:13px/1.5 system-ui,"Microsoft YaHei",sans-serif}
  #wrap{display:flex;height:100%}
  #stage{flex:1;min-width:0;padding:12px}
  iframe{width:100%;height:100%;border:1px solid #2c303a;border-radius:12px;background:#121419}
  #log{width:330px;border-left:1px solid #2c303a;padding:12px;overflow:auto;background:#171a20}
  #log h3{margin:0 0 8px;font-size:12px;color:#9aa1b2;text-transform:uppercase;letter-spacing:.06em}
  pre{white-space:pre-wrap;word-break:break-word;background:#11141a;border:1px solid #2c303a;border-radius:8px;padding:8px;font-size:11px;line-height:1.55}
  .ok{color:#52c98b}
</style></head>
<body><div id="wrap"><div id="stage"><iframe id="panel" src="/panel.html"></iframe></div>
<div id="log"><h3>Host log</h3><div id="entries"></div></div></div>
<script>
  const frame = document.getElementById('panel');
  const target = () => frame.contentWindow;
  const entries = document.getElementById('entries');
  function log(title, payload){
    const el = document.createElement('div');
    const h = document.createElement('div'); h.textContent = new Date().toLocaleTimeString() + '  ' + title; h.className='ok';
    const pre = document.createElement('pre'); pre.textContent = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    el.appendChild(h); el.appendChild(pre); entries.prepend(el);
  }
  window.__sentMessages = [];
  window.addEventListener('message', async (event) => {
    if (event.source !== target()) return;
    const msg = event.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.method === 'ui/notifications/initialized') { log('initialized', {}); return; }
    if (msg.method === 'ui/notifications/size-changed') return;
    if (msg.method === 'ui/message') {
      window.__sentMessages.push(msg.params);
      log('ui/message (follow-up)', msg.params);
      return respond(msg.id, {});
    }
    if (msg.method === 'ui/update-model-context') {
      log('ui/update-model-context', msg.params);
      return respond(msg.id, {});
    }
    if (msg.method === 'ui/initialize') {
      return respond(msg.id, {
        protocolVersion: msg.params.protocolVersion,
        hostInfo: { name: 'MockZCode', version: '0.1.0' },
        hostCapabilities: ${JSON.stringify(hostCapabilities)},
        hostContext: ${JSON.stringify(hostContext)}
      });
    }
    try {
      const result = await rpc(msg.method, msg.params || {});
      respond(msg.id, result ?? {});
    } catch (error) {
      respondError(msg.id, -32000, error.message || String(error));
    }
  });
  function respond(id, result){ target().postMessage({ jsonrpc:'2.0', id, result }, '*'); }
  function respondError(id, code, message){ target().postMessage({ jsonrpc:'2.0', id, error:{ code, message } }, '*'); }
  async function rpc(method, params){
    if (method === 'tools/call' || method === 'resources/read' || method === 'resources/list' || method === 'tools/list' || method === 'ping') {
      const res = await fetch('/rpc', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ method, params }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data.result;
    }
    if (method === 'ui/open-link') return {};
    if (method === 'ui/download-file') return {};
    if (method === 'ui/set-widget-state') return {};
    if (method === 'ui/request-display-mode') { log('ui/request-display-mode', params); return { mode: params.mode || 'fullscreen' }; }
    return {};
  }
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(HOST_HTML);
      return;
    }
    if (req.method === "GET" && req.url === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/panel.html") {
      const html = await fs.readFile(path.join(root, "dist", "panel.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "POST" && req.url === "/rpc") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { method, params } = JSON.parse(body);
      let result;
      if (method === "tools/call") result = await client.callTool(params);
      else if (method === "resources/read") result = await client.readResource(params);
      else if (method === "resources/list") result = await client.listResources();
      else if (method === "tools/list") result = await client.listTools();
      else result = {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: error?.message || String(error) } }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`mock host: http://127.0.0.1:${port}/`);
  console.log(`plugin data: ${pluginData}`);
  console.log(`theme: ${hostContext.theme} / locale: ${hostContext.locale}`);
});

process.on("SIGINT", async () => {
  server.close();
  await client.close();
  process.exit(0);
});
