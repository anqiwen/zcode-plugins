// figure-studio 面板：列参数 → 调 → 预览 → 写回。
// 全部逻辑走 MCP 工具，不在页面里跑 Python。

import { App } from "@modelcontextprotocol/ext-apps";
import { labelKey, labelScope } from "./labels.js";

const app = new App(
  { name: "figure-studio", version: "0.1.1" },
  { availableDisplayModes: ["inline", "fullscreen"] },
);

const $ = (id) => document.getElementById(id);
const state = {
  script: null,
  records: [],        // inspect 返回的原始参数
  overrides: {},      // 用户改过的（只存改动）
  lastPreview: null,  // 当前图的 object URL
  origPreview: null,  // 原图的 object URL
  origUri: null,      // 原图的资源 URI（按脚本缓存一次）
  scripts: [],        // 扫描结果
  busy: false,
};

// ── 工具调用 ────────────────────────────────────────────────
async function call(name, args = {}) {
  const res = await app.callServerTool({ name, arguments: args });
  const sc = res.structuredContent;
  if (sc && typeof sc === "object" && "ok" in sc) {
    if (!sc.ok) throw new Error(`${sc.error?.code}: ${sc.error?.message}`);
    return sc.data;
  }
  if (res.isError) throw new Error(res.content?.[0]?.text || "工具调用失败");
  return sc;
}

function setStatus(text, kind = "") {
  const el = $("status");
  el.textContent = text;
  el.dataset.kind = kind;
}

async function withBusy(fn) {
  if (state.busy) return;
  state.busy = true;
  document.body.dataset.busy = "1";
  try {
    await fn();
  } catch (e) {
    setStatus(String(e.message || e), "error");
  } finally {
    state.busy = false;
    delete document.body.dataset.busy;
  }
}

// ── 参数渲染 ────────────────────────────────────────────────
function typeOf(value) {
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && /^#[0-9a-f]{3,8}$/i.test(value)) return "color";
  if (Array.isArray(value)) return "list";
  return "text";
}

function currentValue(rec) {
  const key = `${rec.scope}.${rec.key}`;
  return key in state.overrides ? state.overrides[key] : rec.value;
}

function coerce(raw, kind) {
  if (kind === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (kind === "boolean") return Boolean(raw);
  if (kind === "list") {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : raw;
    } catch {
      return raw;
    }
  }
  return raw;
}

function renderParams(records) {
  const host = $("params");
  host.innerHTML = "";
  if (!records.length) {
    host.innerHTML = '<p class="hint">还没有参数。先填脚本路径，点「读取参数」。</p>';
    return;
  }

  const groups = new Map();
  for (const r of records) {
    if (!groups.has(r.scope)) groups.set(r.scope, []);
    groups.get(r.scope).push(r);
  }

  for (const [scope, items] of groups) {
    const box = document.createElement("details");
    box.open = ["figure", "axes.set_ylabel", "axes.set_xlabel", "axes.set_title", "legend", "figure.legend"].includes(scope);
    const sum = document.createElement("summary");
    sum.textContent = `${labelScope(scope)}  (${items.length})`;
    sum.title = scope;
    box.appendChild(sum);

    for (const rec of items) {
      const key = `${rec.scope}.${rec.key}`;
      const kind = typeOf(rec.value);
      const row = document.createElement("label");
      row.className = "row";
      row.dataset.touched = key in state.overrides ? "1" : "0";

      const name = document.createElement("span");
      name.className = "k";
      const zh = labelKey(rec.key);
      if (zh) {
        name.textContent = zh;
        const raw = document.createElement("code");
        raw.textContent = rec.key;
        name.appendChild(raw);
      } else {
        // 没登记的键照原样显示，别猜
        name.textContent = rec.key;
      }
      name.title = `${key}（脚本里出现 ${rec.count} 次）`;
      row.appendChild(name);

      let input;
      if (kind === "color") {
        input = document.createElement("input");
        input.type = "color";
        input.value = String(currentValue(rec)).slice(0, 7);
      } else if (kind === "boolean") {
        input = document.createElement("input");
        input.type = "checkbox";
        input.checked = Boolean(currentValue(rec));
      } else if (kind === "number") {
        input = document.createElement("input");
        input.type = "number";
        input.step = "0.1";
        input.value = currentValue(rec);
      } else {
        input = document.createElement("input");
        input.type = "text";
        input.value = Array.isArray(currentValue(rec))
          ? JSON.stringify(currentValue(rec))
          : String(currentValue(rec));
      }

      input.addEventListener("input", () => {
        let v;
        if (input.type === "checkbox") v = input.checked;
        else v = coerce(input.value, kind);
        if (JSON.stringify(v) === JSON.stringify(rec.value)) {
          delete state.overrides[key];          // 改回原值就撤销覆盖
          row.dataset.touched = "0";
        } else {
          state.overrides[key] = v;
          row.dataset.touched = "1";
        }
        updateCount();
      });

      row.appendChild(input);
      box.appendChild(row);
    }
    host.appendChild(box);
  }
  updateCount();
}

function updateCount() {
  const n = Object.keys(state.overrides).length;
  $("apply").disabled = n === 0;
  $("plan").disabled = n === 0;
  $("render").disabled = !state.script;
  $("count").textContent = n ? `${n} 项已改` : "未改动";
  $("capcur").textContent = n ? `当前 · ${n} 项改动` : "当前 · 与原图相同";
}

// ── 预览图 ──────────────────────────────────────────────────
async function blobUrlOf(uri) {
  const contents = await app.readServerResource({ uri });
  const blob = contents?.contents?.[0]?.blob;
  if (!blob) throw new Error("预览资源为空");
  const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}

async function showPreview(uri) {
  const url = await blobUrlOf(uri);
  if (state.lastPreview) URL.revokeObjectURL(state.lastPreview);
  state.lastPreview = url;
  $("img").src = url;
  $("figcur").hidden = false;
  $("empty").hidden = true;
}

// 原图 = 不带任何覆盖值跑一遍。按脚本缓存，反复开关不重复渲染。
async function showOriginal() {
  if (!state.origUri) {
    const data = await call("render_preview", {
      script: state.script,
      overrides: { "savefig.dpi": 100 },
    });
    state.origUri = data.previewUri;
  }
  const url = await blobUrlOf(state.origUri);
  if (state.origPreview) URL.revokeObjectURL(state.origPreview);
  state.origPreview = url;
  $("imgorig").src = url;
  $("figorig").hidden = false;
}

function resetOriginal() {
  if (state.origPreview) URL.revokeObjectURL(state.origPreview);
  state.origPreview = null;
  state.origUri = null;
  $("figorig").hidden = true;
  $("imgorig").removeAttribute("src");
}

async function doCompare() {
  const on = $("compare").checked;
  $("view").classList.toggle("compare", on);
  if (!on) {
    $("figorig").hidden = true;
    return;
  }
  if (!state.script) return;
  await withBusy(async () => {
    try {
      setStatus("正在画原图…");
      await showOriginal();
      setStatus("上面是原图，下面是当前效果");
    } catch (e) {
      // 出不来原图就退回去，别留一个勾着却没东西的空壳
      $("compare").checked = false;
      $("view").classList.remove("compare");
      $("figorig").hidden = true;
      throw e;
    }
  });
}

// ── 动作 ────────────────────────────────────────────────────
async function doInspect() {
  const script = $("script").value.trim();
  if (!script) return setStatus("先填脚本路径", "error");
  await withBusy(async () => {
    setStatus("正在跑脚本…");
    const data = await call("inspect_script", { script });
    state.script = data.script;
    state.records = data.records;
    state.overrides = {};
    resetOriginal();
    $("compare").checked = false;
    $("view").classList.remove("compare");
    $("figcur").hidden = true;
    $("img").removeAttribute("src");
    $("empty").hidden = false;
    $("warn").hidden = true;
    $("viewbar").hidden = false;
    renderParams(data.records);
    setStatus(`读到 ${data.records.length} 个参数，脚本耗时 ${data.elapsed_ms} ms`);
    if (data.script_stdout) $("log").textContent = data.script_stdout;
  });
}

async function doRender() {
  if (!state.script) return;
  await withBusy(async () => {
    setStatus("重画中…");
    const data = await call("render_preview", {
      script: state.script,
      overrides: { ...state.overrides, "savefig.dpi": 100 },
    });
    await showPreview(data.previewUri);
    // 版面体检：溢出/重叠说明字号和图幅不匹配，别让用户导出一张崩图
    const warn = $("warn");
    if (data.warning_summary) {
      warn.textContent = "⚠ " + data.warning_summary;
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }
    setStatus(`完成，耗时 ${data.elapsed_ms} ms`);
  });
}

async function doPlan() {
  await withBusy(async () => {
    const data = await call("plan_rewrite", {
      script: state.script,
      overrides: state.overrides,
    });
    $("diff").textContent = data.diff || "（无改动）";
    $("diffbox").open = true;
    const skipped = (data.skipped || []).map(([k, why]) => `· ${k} — ${why}`).join("\n");
    $("skipped").textContent = skipped;
    setStatus(`会改 ${data.applied.length} 项，跳过 ${data.skipped.length} 项`);
  });
}

async function doApply() {
  if (!confirm("会把改动写进源码（保留 .bak 备份）。继续？")) return;
  await withBusy(async () => {
    const data = await call("apply_rewrite", {
      script: state.script,
      overrides: state.overrides,
      write: true,
    });
    $("diff").textContent = data.diff || "（无改动）";
    setStatus(`已写入，备份在 ${state.script}.bak`, "ok");
  });
}

// ── 脚本选择浮层 ────────────────────────────────────────────
function openPicker() {
  $("pickwrap").hidden = false;
  $("scan").dataset.on = "1";
  $("pickfilter").focus();
}

function closePicker() {
  $("pickwrap").hidden = true;
  delete $("scan").dataset.on;
}

function renderPicker() {
  const q = $("pickfilter").value.trim().toLowerCase();
  const host = $("picklist");
  host.innerHTML = "";
  const list = state.scripts.filter((s) => !q || s.toLowerCase().includes(q));
  if (!list.length) {
    host.innerHTML = '<p class="hint">没有匹配的脚本</p>';
    return;
  }
  for (const s of list) {
    const b = document.createElement("button");
    b.textContent = s;
    b.className = "pick";
    b.onclick = () => {
      $("script").value = s;
      closePicker();
      doInspect();
    };
    host.appendChild(b);
  }
}

async function doScan() {
  if (!$("pickwrap").hidden) {
    closePicker();
    return;
  }
  await withBusy(async () => {
    const data = await call("list_scripts", { limit: 200 });
    state.scripts = data.scripts;
    $("pickfilter").value = "";
    renderPicker();
    openPicker();
    setStatus(`工作区里找到 ${data.scripts.length} 个 .py，选一个`);
  });
}

// ── 启动 ────────────────────────────────────────────────────
app.ontoolresult = (params) => {
  const sc = params.structuredContent;
  if (sc?.ok && sc.data?.script) {
    $("script").value = sc.data.script;
    doInspect();
  }
};
app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) document.documentElement.dataset.theme = ctx.theme;
};

async function boot() {
  await app.connect();
  document.documentElement.dataset.theme = app.getHostContext()?.theme || "dark";

  $("inspect").onclick = doInspect;
  $("render").onclick = doRender;
  $("plan").onclick = doPlan;
  $("apply").onclick = doApply;
  $("scan").onclick = doScan;
  $("compare").onchange = doCompare;
  $("pickclose").onclick = closePicker;
  $("pickfilter").addEventListener("input", renderPicker);
  $("pickfilter").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("picklist").querySelector(".pick")?.click();
  });
  $("script").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doInspect();
  });

  // 点浮层外面、或按 Esc 都收起来——列表不该一直占着版面
  document.addEventListener("pointerdown", (e) => {
    if ($("pickwrap").hidden) return;
    if (e.target.closest("#pickwrap") || e.target.closest("#scan")) return;
    closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePicker();
  });

  updateCount();
}

boot().catch((e) => setStatus(String(e?.message || e), "error"));
