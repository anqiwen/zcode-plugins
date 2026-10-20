import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import {
  FETCH_TIMEOUT_MS,
  MAX_PERCENT,
  USAGE_ENDPOINT,
  USAGE_HOST,
  WINDOW_KEYS,
} from "../shared/constants.js";
import type { UsageSnapshot, UsageWindow } from "../shared/types.js";
import { AppError, scrub } from "./errors.js";

interface RawWindow {
  status?: unknown;
  percent?: unknown;
  resetsAt?: unknown;
  resets_at?: unknown;
  resetsInSeconds?: unknown;
}

let proxyAgent: EnvHttpProxyAgent | undefined;

function proxyFromEnv(): string | undefined {
  const value =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  return value?.trim() || undefined;
}

/**
 * Build the dispatcher lazily. The proxy comes from the host process
 * environment (Clash and friends); it is never a user-supplied tool argument,
 * so it cannot be used to point the plugin at an arbitrary target.
 */
function dispatcher(): EnvHttpProxyAgent | undefined {
  if (!proxyFromEnv()) return undefined;
  if (!proxyAgent) {
    for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      const raw = process.env[name]?.trim();
      if (!raw) continue;
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new AppError("proxy_invalid", `环境变量 ${name} 不是合法的代理地址`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new AppError("proxy_invalid", `环境变量 ${name} 只支持 http/https 代理`);
      }
    }
    proxyAgent = new EnvHttpProxyAgent();
  }
  return proxyAgent;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseWindow(key: string, raw: unknown): UsageWindow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as RawWindow;
  const status = typeof item.status === "string" ? item.status : "ok";
  const numeric = toNumber(item.percent);
  const percent =
    numeric === null ? null : Math.max(0, Math.min(999, Math.round(numeric * 10) / 10));

  let resetsAt: string | null = null;
  let resetsInSeconds: number | null = null;

  const direct = toNumber(item.resetsInSeconds);
  if (direct !== null) {
    resetsInSeconds = Math.max(0, Math.floor(direct));
    resetsAt = new Date(Date.now() + resetsInSeconds * 1000).toISOString();
  } else if (typeof item.resetsAt === "string") {
    const ms = Date.parse(item.resetsAt);
    if (Number.isFinite(ms)) {
      resetsAt = new Date(ms).toISOString();
      resetsInSeconds = Math.max(0, Math.floor((ms - Date.now()) / 1000));
    }
  } else if (typeof item.resets_at === "string") {
    const ms = Date.parse(item.resets_at);
    if (Number.isFinite(ms)) {
      resetsAt = new Date(ms).toISOString();
      resetsInSeconds = Math.max(0, Math.floor((ms - Date.now()) / 1000));
    }
  }

  return {
    key: key as UsageWindow["key"],
    status,
    percent,
    resetsAt,
    resetsInSeconds,
  };
}

/** Parse the documented (but unofficial) usage payload defensively. */
export function parseUsagePayload(json: unknown): UsageWindow[] {
  if (!json || typeof json !== "object") {
    throw new AppError("bad_response", "用量接口返回了非对象响应");
  }
  const root = json as Record<string, unknown>;
  const data =
    root.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : root;
  const usage =
    data.usage && typeof data.usage === "object"
      ? (data.usage as Record<string, unknown>)
      : data;
  const windows: UsageWindow[] = [];
  for (const key of WINDOW_KEYS) {
    const parsed = parseWindow(key, usage[key]);
    if (parsed) windows.push(parsed);
  }
  if (windows.length === 0) {
    throw new AppError(
      "bad_response",
      `无法从响应中解析 5 小时/每周/每月用量窗口：${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return windows;
}

function statusError(status: number, body: string, secret: string): AppError {
  const snippet = scrub(body.trim().slice(0, 160), secret);
  const suffix = snippet ? `：${snippet}` : "";
  if (status === 401) {
    return new AppError("invalid_key", "API Key 无效或已失效（HTTP 401）");
  }
  if (status === 403) {
    return new AppError("forbidden", `该 API Key 无权访问用量接口（HTTP 403）${suffix}`);
  }
  if (status === 404) {
    return new AppError(
      "not_go_plan",
      "该账号无法访问 Go 用量接口（HTTP 404）；可能不是 OpenCode Go 订阅账号",
    );
  }
  if (status === 429) {
    return new AppError("rate_limited", "请求过于频繁，已被 OpenCode 限流（HTTP 429）");
  }
  if (status >= 500) {
    return new AppError("upstream_error", `OpenCode 服务端错误（HTTP ${status}）`);
  }
  return new AppError("http_error", `用量接口返回 HTTP ${status}${suffix}`);
}

function networkError(error: unknown): AppError {
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code || cause?.message;
  if (error instanceof Error && error.name === "TimeoutError") {
    return new AppError("timeout", "请求用量接口超时（20 秒）");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new AppError("timeout", "请求用量接口超时");
  }
  return new AppError(
    "network_error",
    `无法连接 OpenCode 用量接口${code ? `（${code}）` : ""}`,
  );
}

/** Fetch and normalize one account's quota windows. */
export async function fetchUsage(apiKey: string): Promise<UsageSnapshot> {
  const target = new URL(USAGE_ENDPOINT);
  // The target is a constant; this assertion keeps that property explicit if
  // the endpoint is ever edited.
  if (target.protocol !== "https:" || target.hostname !== USAGE_HOST) {
    throw new AppError("target_rejected", "用量接口地址未通过校验");
  }

  let response;
  try {
    response = await undiciFetch(target, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "zcode-opencode-go-usage/0.1.1",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      dispatcher: dispatcher(),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw networkError(error);
  }

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > 256 * 1024) {
    throw new AppError("bad_response", "用量接口响应过大，已拒绝解析");
  }

  const body = await response.text().catch(() => "");
  if (body.length > 256 * 1024) {
    throw new AppError("bad_response", "用量接口响应过大，已拒绝解析");
  }

  if (!response.ok) {
    throw statusError(response.status, body, apiKey);
  }

  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new AppError("bad_response", "用量接口返回了非 JSON 响应");
  }

  return {
    windows: parseUsagePayload(json),
    fetchedAt: Date.now(),
    stale: false,
    error: null,
  };
}

/** Recompute the countdown from resetsAt so cached snapshots stay accurate. */
export function remainingSeconds(window: UsageWindow, now = Date.now()): number | null {
  if (window.resetsAt) {
    const ms = Date.parse(window.resetsAt);
    if (Number.isFinite(ms)) return Math.max(0, Math.floor((ms - now) / 1000));
  }
  return window.resetsInSeconds;
}

export function percentForBar(window: UsageWindow): number {
  const value = window.percent;
  if (value === null) return 0;
  return Math.max(0, Math.min(MAX_PERCENT, value));
}
