import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR_ENV, PLUGIN_NAME } from "../shared/constants.js";

/** Directory of the running bundle (dist/ in an installed plugin). */
export function bundleDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Plugin root (the directory that contains .zcode-plugin/plugin.json). */
export function pluginRoot(): string {
  return path.resolve(bundleDir(), "..");
}

/**
 * Directory that holds accounts, settings and the encrypted credential blob.
 * The host injects ZCODE_PLUGIN_DATA for MCP servers; the CLI accepts an
 * explicit --data-dir because it runs outside the host process.
 */
export function resolveDataDir(explicit?: string): string {
  const value =
    explicit?.trim() ||
    process.env[DATA_DIR_ENV]?.trim() ||
    process.env.ZCODE_PLUGIN_DATA?.trim() ||
    path.join(os.homedir(), `.${PLUGIN_NAME}`);
  return path.resolve(value);
}

export function cliPath(): string {
  return path.join(bundleDir(), "cli.mjs");
}
