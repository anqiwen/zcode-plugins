import { promises as fs } from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  HTML_MIME,
  PANEL_URI,
  PLUGIN_NAME,
  SURFACE_ID,
} from "../shared/constants.js";
import type { ToolEnvelope } from "../shared/types.js";
import { describeError } from "./errors.js";
import { bundleDir, resolveDataDir } from "./paths.js";
import { UsageService } from "./service.js";

const VERSION = "0.1.1";
const HTML_MIME_VALUE = HTML_MIME;

const service = new UsageService(resolveDataDir());

function ok<T>(data: T): ToolEnvelope<T> {
  return { ok: true, data };
}

function failure(error: unknown) {
  const { code, message } = describeError(error);
  return {
    content: [{ type: "text" as const, text: `错误：${message}` }],
    structuredContent: { ok: false as const, error: { code, message } },
    isError: true as const,
  };
}

function success<T>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: ok(data) as unknown as Record<string, unknown>,
  };
}

const appOnly = { visibility: ["app"] as ["app"] };
const modelAndApp = { visibility: ["model", "app"] as ["model", "app"] };
const panelInline = { resourceUri: PANEL_URI };
const panelSidebar = { resourceUri: PANEL_URI, surface: SURFACE_ID };

const server = new McpServer(
  { name: PLUGIN_NAME, version: VERSION },
  {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
    },
  },
);

server.registerTool(
  "opencode_go_usage",
  {
    title: "查询 OpenCode Go 用量",
    description:
      "查询 OpenCode Go 套餐的订阅额度：5 小时滚动窗口、每周额度、每月额度的已用百分比与重置倒计时，并返回额度预警。可同时查看多个账号。",
    inputSchema: {
      refresh: z.boolean().optional().describe("为 true 时绕过缓存立即请求上游"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { ...panelInline, ...modelAndApp } },
  },
  async ({ refresh }) => {
    try {
      const state = await service.panelState({ force: Boolean(refresh) });
      const lang = state.settings.language === "en-US" ? "en-US" : "zh-CN";
      const text = service.formatText(state, lang);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: ok(state) as unknown as Record<string, unknown>,
      };
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "show_usage_panel",
  {
    title: "打开 OpenCode Go 用量面板",
    description:
      "在对话中内联打开 OpenCode Go 用量面板：多账号切换、5 小时/每周/每月进度条、重置倒计时、手动/定时刷新与额度预警。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { ...panelInline, ...modelAndApp } },
  },
  async () => {
    try {
      const state = await service.panelState();
      return success({
        surface: "inline",
        accounts: state.accounts.length,
        credentialBackend: state.security.credentialBackend,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "show_usage_sidebar",
  {
    title: "在侧栏打开 OpenCode Go 用量面板",
    description:
      "在会话侧栏打开 OpenCode Go 用量面板。仅在用户明确要求固定面板时调用；一般使用 show_usage_panel 内联打开。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { ...panelSidebar, ...modelAndApp } },
  },
  async () => {
    try {
      const state = await service.panelState();
      return success({
        surface: SURFACE_ID,
        accounts: state.accounts.length,
        credentialBackend: state.security.credentialBackend,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "get_panel_state",
  {
    title: "读取用量面板状态",
    description: "面板内部使用：返回账号列表、额度窗口、设置与凭据后端信息（不含 API Key）。",
    inputSchema: {
      force: z.boolean().optional().describe("强制刷新所有账号"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: appOnly },
  },
  async ({ force }) => {
    try {
      return success(await service.panelState({ force: Boolean(force) }));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "refresh_usage",
  {
    title: "刷新能源用量",
    description: "面板内部使用：立即刷新全部账号，或只刷新指定账号。",
    inputSchema: {
      accountId: z.string().optional().describe("只刷新这个账号；省略则刷新全部"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: appOnly },
  },
  async ({ accountId }) => {
    try {
      return success(await service.forceRefresh(accountId));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "test_account",
  {
    title: "测试单个账号",
    description: "面板内部使用：立即请求指定账号的用量接口，用于验证 Key 是否可用。",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: appOnly },
  },
  async ({ id }) => {
    try {
      return success(await service.testAccount(id));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "rename_account",
  {
    title: "重命名账号",
    description: "面板内部使用：修改本地账号显示名（不影响上游账户）。",
    inputSchema: { id: z.string(), label: z.string().min(1).max(60) },
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async ({ id, label }) => {
    try {
      return success(await service.renameAccount(id, label));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "set_account_enabled",
  {
    title: "启用或停用账号",
    description: "面板内部使用：停用后不再自动刷新该账号，但仍保留其凭据。",
    inputSchema: { id: z.string(), enabled: z.boolean() },
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async ({ id, enabled }) => {
    try {
      return success(await service.setAccountEnabled(id, enabled));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "remove_account",
  {
    title: "删除账号",
    description: "面板内部使用：删除账号元数据及其加密保存的 API Key。环境变量账号不能删除。",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async ({ id }) => {
    try {
      return success(await service.removeAccount(id));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "update_settings",
  {
    title: "更新面板设置",
    description:
      "面板内部使用：修改自动刷新间隔（60–3600 秒）、预警阈值、严重阈值与界面语言。",
    inputSchema: {
      refreshSeconds: z.number().int().min(60).max(3600).optional(),
      warningPercent: z.number().int().min(50).max(99).optional(),
      criticalPercent: z.number().int().min(51).max(100).optional(),
      language: z.enum(["auto", "zh-CN", "en-US"]).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async (patch) => {
    try {
      return success(await service.updateSettings(patch));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "import_env_accounts",
  {
    title: "导入环境变量账号",
    description:
      "面板内部使用：把 OPENCODE_GO_API_KEY、OPENCODE_GO_API_KEY_2…_9 导入加密凭据库，便于多账号管理。",
    inputSchema: {},
    annotations: { readOnlyHint: false, openWorldHint: false },
    _meta: { ui: appOnly },
  },
  async () => {
    try {
      const result = await service.importEnvAccounts();
      return success({
        state: result.state,
        imported: result.imported,
        skipped: result.skipped,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerResource(
  "panel",
  PANEL_URI,
  { mimeType: HTML_MIME_VALUE, title: "OpenCode Go Usage" },
  async () => ({
    contents: [
      {
        uri: PANEL_URI,
        mimeType: HTML_MIME_VALUE,
        text: await fs.readFile(path.join(bundleDir(), "panel.html"), "utf8"),
      },
    ],
  }),
);

async function main(): Promise<void> {
  await service.init().catch((error) => {
    process.stderr.write(`[${PLUGIN_NAME}] init warning: ${describeError(error).message}\n`);
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `[${PLUGIN_NAME}] ready data=${service.dataDir} credential=${service.credentials.backendName}\n`,
  );
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`[${PLUGIN_NAME}] uncaught: ${error?.stack || error}\n`);
});
process.on("unhandledRejection", (error) => {
  process.stderr.write(`[${PLUGIN_NAME}] unhandled: ${error}\n`);
});

main().catch((error) => {
  process.stderr.write(`[${PLUGIN_NAME}] fatal: ${error?.stack || error}\n`);
  process.exit(1);
});
