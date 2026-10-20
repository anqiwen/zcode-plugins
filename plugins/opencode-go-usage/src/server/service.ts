import path from "node:path";
import type {
  AccountView,
  PanelState,
  Settings,
  UsageSnapshot,
  UsageWarning,
} from "../shared/types.js";
import { AccountStore, type AccountRecord } from "./accounts.js";
import { CredentialStore, envKeys, fingerprint, type EnvKey } from "./credentials.js";
import { AppError, describeError } from "./errors.js";
import { readJsonFile, writeJsonAtomic } from "./files.js";
import { cliPath, pluginRoot, resolveDataDir } from "./paths.js";
import { SettingsStore } from "./settings.js";
import { fetchUsage, remainingSeconds } from "./usage.js";

interface ResolvedAccount {
  id: string;
  label: string;
  fingerprint: string;
  source: "store" | "env";
  enabled: boolean;
  createdAt: number;
  key: string;
}

interface LastUsageFile {
  version: 1;
  snapshots: Record<
    string,
    { windows: UsageSnapshot["windows"]; fetchedAt: number }
  >;
}

const MAX_PARALLEL_FETCHES = 3;
const MIN_RETRY_MS = 15_000;

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class UsageService {
  readonly accounts: AccountStore;
  readonly credentials: CredentialStore;
  readonly settingsStore: SettingsStore;
  readonly dataDir: string;
  private cache = new Map<string, UsageSnapshot>();
  private inflight = new Map<string, Promise<UsageSnapshot>>();
  private lastAttempt = new Map<string, number>();
  private lastUsagePath: string;
  private initialized = false;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(dataDir = resolveDataDir()) {
    this.dataDir = dataDir;
    this.accounts = new AccountStore(dataDir);
    this.credentials = new CredentialStore(dataDir);
    this.settingsStore = new SettingsStore(dataDir);
    this.lastUsagePath = path.join(dataDir, "last-usage.json");
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await Promise.all([
      this.accounts.init(),
      this.credentials.init(),
      this.settingsStore.init(),
    ]);
    await this.accounts.prune(new Set(this.credentials.ids()));
    await this.loadLastUsage();
    this.initialized = true;
  }

  private loadEnvAccounts(): EnvKey[] {
    try {
      return envKeys();
    } catch {
      // A malformed environment key must not take the whole panel down; the
      // account simply does not appear.
      return [];
    }
  }

  private resolveAccounts(): ResolvedAccount[] {
    const storeRecords = this.accounts.list();
    const seen = new Set<string>();
    const resolved: ResolvedAccount[] = [];
    for (const record of storeRecords) {
      const key = this.credentials.get(record.id);
      if (!key) continue;
      seen.add(record.fingerprint);
      resolved.push({
        id: record.id,
        label: record.label,
        fingerprint: record.fingerprint,
        source: "store",
        enabled: record.enabled,
        createdAt: record.createdAt,
        key,
      });
    }
    for (const env of this.loadEnvAccounts()) {
      if (seen.has(env.fingerprint)) continue;
      seen.add(env.fingerprint);
      resolved.push({
        id: env.id,
        label: env.label,
        fingerprint: env.fingerprint,
        source: "env",
        enabled: true,
        createdAt: 0,
        key: env.key,
      });
    }
    return resolved;
  }

  /** Secret-free account list for the CLI (no upstream request). */
  async listAccountInfo(): Promise<
    Array<Pick<ResolvedAccount, "id" | "label" | "fingerprint" | "source" | "enabled">>
  > {
    await this.init();
    return this.resolveAccounts().map(({ id, label, fingerprint, source, enabled }) => ({
      id,
      label,
      fingerprint,
      source,
      enabled,
    }));
  }

  private async loadLastUsage(): Promise<void> {
    const parsed = await readJsonFile<LastUsageFile | null>(this.lastUsagePath, null);
    if (!parsed?.snapshots) return;
    for (const [id, snapshot] of Object.entries(parsed.snapshots)) {
      if (!snapshot || !Array.isArray(snapshot.windows)) continue;
      this.cache.set(id, {
        windows: snapshot.windows,
        fetchedAt: Number(snapshot.fetchedAt) || 0,
        stale: false,
        error: null,
      });
    }
  }

  private persistLastUsage(): void {
    const snapshots: LastUsageFile["snapshots"] = {};
    for (const [id, snapshot] of this.cache) {
      if (snapshot.error || snapshot.windows.length === 0) continue;
      snapshots[id] = { windows: snapshot.windows, fetchedAt: snapshot.fetchedAt };
    }
    this.persistQueue = this.persistQueue.then(async () => {
      await writeJsonAtomic(this.lastUsagePath, { version: 1, snapshots });
    });
    this.persistQueue.catch(() => {
      /* last-usage.json is a cache; failing to write it must not break the panel */
    });
  }

  private async refreshResolved(
    account: ResolvedAccount,
    force: boolean,
    ttlMs: number,
  ): Promise<UsageSnapshot> {
    const cached = this.cache.get(account.id);
    if (!force) {
      const fresh = cached && Date.now() - cached.fetchedAt < ttlMs && !cached.error;
      if (fresh) return cached;
      const attempted = this.lastAttempt.get(account.id) ?? 0;
      if (cached?.error && Date.now() - attempted < MIN_RETRY_MS) return cached;
    }
    const running = this.inflight.get(account.id);
    if (running) return running;

    const task = (async () => {
      this.lastAttempt.set(account.id, Date.now());
      try {
        const snapshot = await fetchUsage(account.key);
        this.cache.set(account.id, snapshot);
        this.persistLastUsage();
        return snapshot;
      } catch (error) {
        const previous = this.cache.get(account.id);
        const failed: UsageSnapshot = {
          windows: previous?.windows ?? [],
          fetchedAt: previous?.fetchedAt ?? 0,
          stale: true,
          error: describeError(error),
        };
        this.cache.set(account.id, failed);
        return failed;
      } finally {
        this.inflight.delete(account.id);
      }
    })();
    this.inflight.set(account.id, task);
    return task;
  }

  async panelState(options: { force?: boolean } = {}): Promise<PanelState> {
    await this.init();
    const settings = this.settingsStore.get();
    const resolved = this.resolveAccounts();
    const enabled = resolved.filter((account) => account.enabled);
    const ttlMs = settings.refreshSeconds * 1000;
    await mapLimit(enabled, MAX_PARALLEL_FETCHES, (account) =>
      this.refreshResolved(account, Boolean(options.force), ttlMs),
    );

    const accounts: AccountView[] = resolved.map((account) => ({
      id: account.id,
      label: account.label,
      fingerprint: account.fingerprint,
      source: account.source,
      enabled: account.enabled,
      createdAt: account.createdAt,
      usage: this.cache.get(account.id) ?? null,
    }));

    return {
      accounts,
      settings,
      security: {
        credentialBackend: this.credentials.backendName,
        dataDir: this.dataDir,
        pluginRoot: pluginRoot(),
        cliPath: cliPath(),
        nodePath: /^node(\.exe)?$/i.test(path.basename(process.execPath))
          ? process.execPath
          : "node",
        platform: process.platform,
        envAccountCount: this.loadEnvAccounts().length,
      },
      warnings: this.computeWarnings(accounts, settings),
      generatedAt: Date.now(),
    };
  }

  private computeWarnings(accounts: AccountView[], settings: Settings): UsageWarning[] {
    const warnings: UsageWarning[] = [];
    for (const account of accounts) {
      if (!account.enabled || !account.usage) continue;
      for (const window of account.usage.windows) {
        if (window.percent === null) continue;
        const level =
          window.percent >= settings.criticalPercent
            ? "critical"
            : window.percent >= settings.warningPercent
              ? "warning"
              : null;
        if (!level) continue;
        warnings.push({
          accountId: account.id,
          accountLabel: account.label,
          window: window.key,
          percent: window.percent,
          level,
        });
      }
    }
    return warnings.sort((a, b) => b.percent - a.percent);
  }

  async forceRefresh(accountId?: string): Promise<PanelState> {
    await this.init();
    if (accountId) {
      const account = this.resolveAccounts().find((item) => item.id === accountId);
      if (!account) throw new AppError("account_not_found", "账号不存在或已删除");
      if (!account.enabled) {
        throw new AppError("account_disabled", "该账号已停用，启用后才能刷新");
      }
      await this.refreshResolved(account, true, 0);
      // Return the full state without forcing every other account again.
      return this.panelState({ force: false });
    }
    return this.panelState({ force: true });
  }

  async testAccount(accountId: string): Promise<PanelState> {
    return this.forceRefresh(accountId);
  }

  async renameAccount(accountId: string, label: string): Promise<PanelState> {
    await this.init();
    const target = this.resolveAccounts().find((item) => item.id === accountId);
    if (!target) throw new AppError("account_not_found", "账号不存在或已删除");
    if (target.source === "env") {
      throw new AppError(
        "env_account_immutable",
        "环境变量账号的名称由 OPENCODE_GO_LABEL 决定，不能在面板中重命名",
      );
    }
    await this.accounts.rename(accountId, label);
    return this.panelState();
  }

  async setAccountEnabled(accountId: string, enabled: boolean): Promise<PanelState> {
    await this.init();
    const target = this.resolveAccounts().find((item) => item.id === accountId);
    if (!target) throw new AppError("account_not_found", "账号不存在或已删除");
    if (target.source === "env") {
      throw new AppError(
        "env_account_immutable",
        "环境变量账号始终启用；如需停用请移除对应的环境变量",
      );
    }
    await this.accounts.setEnabled(accountId, enabled);
    if (!enabled) this.cache.delete(accountId);
    return this.panelState();
  }

  async removeAccount(accountId: string): Promise<PanelState> {
    await this.init();
    const target = this.resolveAccounts().find((item) => item.id === accountId);
    if (!target) throw new AppError("account_not_found", "账号不存在或已删除");
    if (target.source === "env") {
      throw new AppError(
        "env_account_immutable",
        "环境变量账号不能在此删除；请移除对应的环境变量后重启会话",
      );
    }
    await this.accounts.remove(accountId);
    await this.credentials.delete(accountId);
    this.cache.delete(accountId);
    this.persistLastUsage();
    return this.panelState();
  }

  async updateSettings(patch: Partial<Settings>): Promise<PanelState> {
    await this.init();
    await this.settingsStore.update(patch);
    return this.panelState();
  }

  async importEnvAccounts(): Promise<{ imported: number; skipped: number; state: PanelState }> {
    await this.init();
    const existing = new Set(
      this.accounts.list().map((record: AccountRecord) => record.fingerprint),
    );
    for (const id of this.credentials.ids()) {
      const key = this.credentials.get(id);
      if (key) existing.add(fingerprint(key));
    }
    let imported = 0;
    let skipped = 0;
    for (const env of this.loadEnvAccounts()) {
      if (existing.has(env.fingerprint)) {
        skipped += 1;
        continue;
      }
      const record = await this.accounts.add(env.label, env.key);
      await this.credentials.set(record.id, env.key);
      existing.add(env.fingerprint);
      imported += 1;
    }
    return { imported, skipped, state: await this.panelState() };
  }

  /** Human-readable summary used by the agent-facing tool. */
  formatText(state: PanelState, lang: "zh-CN" | "en-US" = "zh-CN"): string {
    if (state.accounts.length === 0) {
      return lang === "zh-CN"
        ? "尚未配置 OpenCode Go 账号。请在用量面板中按提示导入 API Key，或设置环境变量 OPENCODE_GO_API_KEY。"
        : "No OpenCode Go account is configured. Add an API key from the usage panel or set OPENCODE_GO_API_KEY.";
    }
    const labels: Record<string, string> =
      lang === "zh-CN"
        ? { rolling: "5 小时", weekly: "每周", monthly: "每月" }
        : { rolling: "5h", weekly: "Weekly", monthly: "Monthly" };
    const lines: string[] = [
      lang === "zh-CN"
        ? `OpenCode Go 用量（${state.accounts.length} 个账号）`
        : `OpenCode Go usage (${state.accounts.length} accounts)`,
    ];
    for (const account of state.accounts) {
      const suffix = account.enabled ? "" : lang === "zh-CN" ? "（已停用）" : " (disabled)";
      lines.push(`${account.label}${suffix} · ${account.fingerprint}`);
      if (!account.usage || account.usage.windows.length === 0) {
        const error = account.usage?.error?.message;
        lines.push(
          error
            ? `  ${lang === "zh-CN" ? "查询失败" : "Query failed"}: ${error}`
            : `  ${lang === "zh-CN" ? "尚无数据" : "No data yet"}`,
        );
        continue;
      }
      for (const window of account.usage.windows) {
        const percent =
          window.percent === null ? "?" : `${Math.round(window.percent * 10) / 10}%`;
        const seconds = remainingSeconds(window);
        const reset = formatDuration(seconds, lang);
        const warn =
          window.percent !== null && window.percent >= state.settings.warningPercent
            ? lang === "zh-CN"
              ? " ⚠ 接近上限"
              : " ⚠ near limit"
            : "";
        lines.push(
          `  ${labels[window.key] ?? window.key}: ${percent}${warn} · ${
            lang === "zh-CN" ? "重置于" : "resets in"
          } ${reset}`,
        );
      }
      const error = account.usage.error?.message;
      if (error) {
        lines.push(`  ${lang === "zh-CN" ? "上次错误" : "Last error"}: ${error}`);
      }
    }
    lines.push(
      `${
        lang === "zh-CN" ? "抓取时间" : "Fetched at"
      }: ${new Date(state.generatedAt).toLocaleString(lang)}`,
    );
    return lines.join("\n");
  }
}

export function formatDuration(seconds: number | null, lang: "zh-CN" | "en-US"): string {
  if (seconds === null || !Number.isFinite(seconds)) return lang === "zh-CN" ? "未知" : "unknown";
  if (seconds <= 0) return lang === "zh-CN" ? "已重置" : "reset";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (lang === "en-US") {
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${secs}s`;
    return `${secs}s`;
  }
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${secs} 秒`;
  return `${secs} 秒`;
}
