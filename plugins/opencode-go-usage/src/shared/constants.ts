import type { Lang, WindowKey } from "./types.js";

export const PLUGIN_NAME = "opencode-go-usage";
export const PANEL_URI = "ui://opencode-go-usage/panel.html";
export const SURFACE_ID = "usage";
export const HTML_MIME = "text/html;profile=mcp-app";

export const USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";
export const USAGE_HOST = "opencode.ai";
export const KEY_ENV = "OPENCODE_GO_API_KEY";
export const KEY_ENV_INDEXED = /^OPENCODE_GO_API_KEY_([2-9])$/;
export const LABEL_ENV = "OPENCODE_GO_LABEL";
export const DATA_DIR_ENV = "OPENCODE_GO_USAGE_DATA";

export const WINDOW_KEYS: WindowKey[] = ["rolling", "weekly", "monthly"];

export const WINDOW_LABELS: Record<Lang, Record<WindowKey, string>> = {
  "zh-CN": {
    rolling: "5 小时窗口",
    weekly: "每周额度",
    monthly: "每月额度",
  },
  "en-US": {
    rolling: "5-hour window",
    weekly: "Weekly quota",
    monthly: "Monthly quota",
  },
};

export const WINDOW_SHORT: Record<Lang, Record<WindowKey, string>> = {
  "zh-CN": { rolling: "5 小时", weekly: "每周", monthly: "每月" },
  "en-US": { rolling: "5h", weekly: "Weekly", monthly: "Monthly" },
};

export const DEFAULT_SETTINGS = {
  refreshSeconds: 300,
  warningPercent: 80,
  criticalPercent: 95,
  language: "auto" as const,
};

export const REFRESH_MIN_SECONDS = 60;
export const REFRESH_MAX_SECONDS = 3600;
export const FETCH_TIMEOUT_MS = 20_000;
export const MAX_PERCENT = 100;

export const FINGERPRINT_PREFIX = "sha256:";
