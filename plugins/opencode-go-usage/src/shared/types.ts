export type WindowKey = "rolling" | "weekly" | "monthly";
export type Lang = "zh-CN" | "en-US";
export type LanguageSetting = "auto" | Lang;
export type CredentialBackend = "dpapi" | "aes-gcm";

export interface UsageWindow {
  key: WindowKey;
  /** Upstream status string, normally "ok". */
  status: string;
  /** Used share 0..100; null when the upstream did not report a number. */
  percent: number | null;
  /** ISO timestamp of the next reset, when reported. */
  resetsAt: string | null;
  /** Seconds until reset, captured when the response was parsed. */
  resetsInSeconds: number | null;
}

export interface UsageError {
  code: string;
  message: string;
}

export interface UsageSnapshot {
  windows: UsageWindow[];
  fetchedAt: number;
  /** True when this is the last good snapshot and the latest fetch failed. */
  stale: boolean;
  error: UsageError | null;
}

export interface AccountView {
  id: string;
  label: string;
  /** SHA-256 prefix of the key. The key itself never leaves the host process. */
  fingerprint: string;
  source: "store" | "env";
  enabled: boolean;
  createdAt: number;
  usage: UsageSnapshot | null;
}

export interface Settings {
  refreshSeconds: number;
  warningPercent: number;
  criticalPercent: number;
  language: LanguageSetting;
}

export interface UsageWarning {
  accountId: string;
  accountLabel: string;
  window: WindowKey;
  percent: number;
  level: "warning" | "critical";
}

export interface SecurityInfo {
  credentialBackend: CredentialBackend;
  dataDir: string;
  pluginRoot: string;
  cliPath: string;
  nodePath: string;
  platform: string;
  envAccountCount: number;
}

export interface PanelState {
  accounts: AccountView[];
  settings: Settings;
  security: SecurityInfo;
  warnings: UsageWarning[];
  generatedAt: number;
}

export interface ToolEnvelope<T> {
  ok: true;
  data: T;
}

export interface ToolFailure {
  ok: false;
  error: UsageError;
}
