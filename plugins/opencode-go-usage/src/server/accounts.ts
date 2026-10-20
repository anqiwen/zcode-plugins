import { randomBytes } from "node:crypto";
import path from "node:path";
import { AppError } from "./errors.js";
import { cleanLabel, readJsonFile, writeJsonAtomic } from "./files.js";
import { fingerprint } from "./credentials.js";

export interface AccountRecord {
  id: string;
  label: string;
  fingerprint: string;
  createdAt: number;
  enabled: boolean;
}

interface AccountsFile {
  version: 1;
  accounts: AccountRecord[];
}

const EMPTY: AccountsFile = { version: 1, accounts: [] };

export class AccountStore {
  private readonly file: string;
  private accounts: AccountRecord[] = [];
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "accounts.json");
  }

  get filePath(): string {
    return this.file;
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    const parsed = await readJsonFile<AccountsFile>(this.file, EMPTY);
    this.accounts = Array.isArray(parsed.accounts)
      ? parsed.accounts.filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.label === "string" &&
            typeof item.fingerprint === "string",
        )
      : [];
    this.loaded = true;
  }

  list(): AccountRecord[] {
    return [...this.accounts];
  }

  find(id: string): AccountRecord | undefined {
    return this.accounts.find((item) => item.id === id);
  }

  findByFingerprint(value: string): AccountRecord | undefined {
    return this.accounts.find((item) => item.fingerprint === value);
  }

  async add(label: string, key: string): Promise<AccountRecord> {
    return this.mutate(async (accounts) => {
      const fp = fingerprint(key);
      const duplicate = accounts.find((item) => item.fingerprint === fp);
      if (duplicate) {
        throw new AppError(
          "duplicate_account",
          `该 API Key 已存在于账号「${duplicate.label}」`,
        );
      }
      const id = `acc_${randomBytes(4).toString("hex")}`;
      const record: AccountRecord = {
        id,
        label: cleanLabel(label) ?? "OpenCode Go",
        fingerprint: fp,
        createdAt: Date.now(),
        enabled: true,
      };
      accounts.push(record);
      return record;
    });
  }

  async rename(id: string, label: string): Promise<AccountRecord> {
    return this.mutate(async (accounts) => {
      const record = accounts.find((item) => item.id === id);
      if (!record) throw new AppError("account_not_found", "账号不存在或已删除");
      record.label = cleanLabel(label) ?? record.label;
      return record;
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<AccountRecord> {
    return this.mutate(async (accounts) => {
      const record = accounts.find((item) => item.id === id);
      if (!record) throw new AppError("account_not_found", "账号不存在或已删除");
      record.enabled = enabled;
      return record;
    });
  }

  async remove(id: string): Promise<AccountRecord> {
    return this.mutate(async (accounts) => {
      const index = accounts.findIndex((item) => item.id === id);
      if (index < 0) throw new AppError("account_not_found", "账号不存在或已删除");
      const [record] = accounts.splice(index, 1);
      return record;
    });
  }

  /** Prune metadata that has no matching key in the credential store. */
  async prune(validIds: Set<string>): Promise<void> {
    await this.mutate(async (accounts) => {
      for (let index = accounts.length - 1; index >= 0; index -= 1) {
        if (!validIds.has(accounts[index].id)) accounts.splice(index, 1);
      }
    });
  }

  /**
   * Serialize read-modify-write cycles: the panel can fire rename/remove/toggle
   * requests in quick succession and every one of them must see the previous
   * result.
   */
  private mutate<T>(fn: (accounts: AccountRecord[]) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      await this.init();
      const result = await fn(this.accounts);
      await writeJsonAtomic(this.file, { version: 1, accounts: this.accounts });
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
