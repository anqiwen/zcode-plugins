// Mock MCP Apps host: serves the real panel.html in an iframe and answers the
// postMessage JSON-RPC handshake, proxying tools/call + resources/read to the
// REAL bundled stdio MCP server. Start with: node test/mock-host.mjs
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PANEL = path.join(ROOT, "dist", "ui", "panel.html");
const SERVER = path.join(ROOT, "dist", "server.mjs");
const PORT = 8777;

// Connect one real MCP client for the whole host lifetime.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  env: { ...process.env },
});
const mcp = new Client({ name: "mock-host", version: "1.0.0" });
await mcp.connect(transport);

const initializeResult = {
  protocolVersion: "2025-11-21",
  hostInfo: { name: "mock-host", version: "1.0.0" },
  hostCapabilities: {
    serverTools: {},
    serverResources: {},
    message: { text: {} },
    updateModelContext: {},
    logging: {},
    experimental: {
      "zcode/widgetState": {},
      "zcode/resourceSubscribe": {},
      "zcode/surface": { id: "obsidian-vault" },
    },
  },
  hostContext: {
    theme: "light",
    displayMode: "inline",
    availableDisplayModes: ["inline", "fullscreen"],
    locale: "zh-CN",
    platform: "web",
  },
};

const hostHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>Mock MCP Apps Host · Obsidian Vault Panel</title>
<style>
  body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f0f2f5;color:#24292f}
  header{background:#fff;border-bottom:1px solid #d8dee4;padding:10px 16px;display:flex;gap:12px;align-items:center}
  header h1{font-size:14px;margin:0;font-weight:600}
  header .tag{font-size:11px;color:#6e7781;background:#eef0f3;padding:3px 8px;border-radius:10px}
  #log{flex:0 0 190px;height:calc(100vh - 52px);overflow:auto;background:#0d1117;color:#8ab4f8;font:11px/1.5 ui-monospace,monospace;padding:8px}
  #log div{border-bottom:1px solid #21262d;padding:2px 0;word-break:break-all}
  .wrap{display:flex}
  iframe{flex:1;height:calc(100vh - 52px);border:0;background:#fff}
</style></head><body>
<header><h1>◈ Mock MCP Apps 宿主</h1><span class="tag">真实 panel.html + 真实 stdio MCP 服务</span>
<span class="tag" id="state">握手中…</span></header>
<div class="wrap"><div id="log"></div><iframe id="frame" src="/panel.html" sandbox="allow-scripts allow-same-origin"></iframe></div>
<script>
  const frame = document.getElementById('frame');
  const logEl = document.getElementById('log');
  function log(s){const d=document.createElement('div');d.textContent=s;logEl.appendChild(d);logEl.scrollTop=logEl.scrollHeight;console.log('[HOST]',s)}
  const pending = new Map(); let seq = 1;
  function post(msg){ frame.contentWindow.postMessage(msg,'*'); }

  async function rpc(method, params){
    const r = await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params})});
    return await r.json();
  }
  window.addEventListener('message', async (e)=>{
    const data = e.data;
    if(!data || data.jsonrpc !== '2.0') return;
    if(data.id !== undefined && data.method){
      // request from the app -> host
      let result;
      try{
        if(data.method === 'ui/initialize'){ result = ${JSON.stringify(initializeResult)}; document.getElementById('state').textContent='✓ 握手完成'; }
        else if(data.method === 'tools/call' || data.method === 'resources/read' || data.method === 'resources/list' || data.method === 'resources/templates/list'){
          const proxied = await rpc(data.method, data.params||{});
          if(proxied && proxied.__rpc_error){ throw new Error(proxied.__rpc_error); }
          result = proxied;
        }
        else if(data.method === 'ui/message' || data.method === 'ui/update-model-context' || data.method === 'ui/open-link' || data.method === 'ui/request-display-mode' || data.method === 'ui/set-widget-state'){
          log('app→host '+data.method); result = {};
        }
        else { log('unhandled request '+data.method); result = {}; }
        post({jsonrpc:'2.0', id:data.id, result});
        log('← '+data.method+' #'+data.id);
      }catch(err){
        post({jsonrpc:'2.0', id:data.id, error:{code:-32000, message:String(err.message||err)}});
        log('ERR '+data.method+': '+err.message);
      }
    } else if(data.id !== undefined){
      // response to a host-initiated request
      const p = pending.get(data.id); if(p){pending.delete(data.id); (data.error?p.reject(new Error(data.error.message)):p.resolve(data.result));}
    } else {
      // notification
      log('notification '+data.method);
    }
  });
  // Simulate ZCode's plugin sandbox: webPreferences.disableDialogs=true makes
  // window.prompt/confirm/alert silent no-ops. Without this, a mock test would
  // wrongly pass even if the panel still relied on native dialogs.
  frame.addEventListener('load', () => {
    try {
      const w = frame.contentWindow;
      w.prompt = () => null;
      w.confirm = () => false;
      w.alert = () => {};
    } catch(e) { log('dialog stub failed: '+e.message); }
  });
  log('宿主就绪，等待 panel 握手…（已模拟 disableDialogs）');
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url?.startsWith("/index")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(hostHtml);
  }
  if (req.url === "/panel.html") {
    try {
      const html = await fs.readFile(PANEL, "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch (e) {
      res.writeHead(500); return res.end(String(e));
    }
  }
  if (req.url === "/rpc" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    try {
      const { method, params } = JSON.parse(body);
      let result;
      if (method === "tools/call") result = await mcp.callTool(params);
      else if (method === "resources/read") result = await mcp.readResource(params);
      else if (method === "resources/list") result = await mcp.listResources(params);
      else if (method === "resources/templates/list") result = await mcp.listResourceTemplates(params);
      else result = {};
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ __rpc_error: String(e.message || e) }));
    }
  }
  res.writeHead(404); res.end("not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Mock host ready: http://127.0.0.1:${PORT}`);
  console.log("Open this URL in a browser to test the panel end-to-end.");
});
