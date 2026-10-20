#!/usr/bin/env node
/**
 * End-to-end smoke test for the MCP server (no ZCode host required).
 *
 *   node scripts/smoke.mjs [data-dir]
 *
 * The data dir must already contain an account (see README: CLI `add`).
 */
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const dataDir = path.resolve(
  process.argv[2] ||
    process.env.OPENCODE_GO_USAGE_DATA ||
    path.join(pluginRoot, "..", "..", ".opencode-go-usage-dev", "data"),
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.env.SMOKE_SERVER || path.join(pluginRoot, "dist", "server.mjs")],
  env: {
    ...process.env,
    ZCODE_PLUGIN_DATA: dataDir,
    OPENCODE_GO_USAGE_DATA: dataDir,
  },
  stderr: "pipe",
});
let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client({ name: "smoke", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

function data(result) {
  assert.equal(result.structuredContent?.ok, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.data;
}

try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  console.log("tools:", names.join(", "));
  for (const required of [
    "opencode_go_usage",
    "show_usage_panel",
    "show_usage_sidebar",
    "get_panel_state",
    "refresh_usage",
    "test_account",
    "rename_account",
    "set_account_enabled",
    "remove_account",
    "update_settings",
    "import_env_accounts",
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }

  const usage = await client.callTool({
    name: "opencode_go_usage",
    arguments: { refresh: true },
  });
  const state = data(usage);
  assert.ok(Array.isArray(state.accounts) && state.accounts.length > 0, "no accounts");
  const account = state.accounts[0];
  assert.equal(typeof account.fingerprint, "string");
  assert.ok(account.usage?.windows?.length >= 3, "usage windows missing");
  const keys = account.usage.windows.map((window) => window.key).join(",");
  assert.equal(keys, "rolling,weekly,monthly");
  for (const window of account.usage.windows) {
    assert.equal(typeof window.percent, "number");
    assert.ok(window.resetsAt, `missing resetsAt for ${window.key}`);
  }
  const text = usage.content?.[0]?.text ?? "";
  console.log("--- agent text ---\n" + text);

  const stateResult = await client.callTool({
    name: "get_panel_state",
    arguments: { force: false },
  });
  const panel = data(stateResult);
  assert.ok(panel.security?.credentialBackend, "no credential backend");
  assert.equal(panel.security.dataDir, dataDir);

  const resource = await client.readResource({ uri: "ui://opencode-go-usage/panel.html" });
  const html = resource.contents?.[0]?.text ?? "";
  assert.equal(resource.contents?.[0]?.mimeType, "text/html;profile=mcp-app");
  assert.ok(html.includes("OpenCode Go"), "panel html missing title");
  console.log("panel html bytes:", html.length);

  // The key must not appear in any tool result or the server log.
  const key =
    process.env.OPENCODE_GO_API_KEY ||
    process.env.OPENCODE_GO_API_KEY_2 ||
    "";
  const serialized = JSON.stringify({ usage, stateResult }) + text + stderr;
  if (key) {
    assert.equal(serialized.includes(key), false, "API key leaked into a tool result or log");
    console.log("secret leak check: clean");
  } else {
    console.log("secret leak check: skipped (no key in env)");
  }

  const updated = data(
    await client.callTool({
      name: "update_settings",
      arguments: {
        refreshSeconds: 120,
        warningPercent: 70,
        criticalPercent: 90,
        language: "auto",
      },
    }),
  );
  assert.equal(updated.settings.refreshSeconds, 120);
  assert.equal(updated.settings.warningPercent, 70);

  const renamed = data(
    await client.callTool({
      name: "rename_account",
      arguments: { id: account.id, label: account.label },
    }),
  );
  assert.ok(renamed.accounts.some((item) => item.id === account.id));

  const imported = data(
    await client.callTool({ name: "import_env_accounts", arguments: {} }),
  );
  assert.ok(Array.isArray(imported.state.accounts));

  console.log("smoke: PASS");
} finally {
  await client.close();
  if (stderr.trim()) {
    console.log("--- server stderr ---\n" + stderr.trim());
  }
}
