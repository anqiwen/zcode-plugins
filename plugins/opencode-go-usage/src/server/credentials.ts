import { spawnSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  FINGERPRINT_PREFIX,
  KEY_ENV,
  KEY_ENV_INDEXED,
  LABEL_ENV,
} from "../shared/constants.js";
import type { CredentialBackend } from "../shared/types.js";
import { AppError } from "./errors.js";
import { readJsonFile, writeJsonAtomic, writeTextAtomic } from "./files.js";
import { bundleDir } from "./paths.js";

const SECRETS_FILE = "secrets.dat";
const KEY_FILE = "secrets.key";
const AES_AAD = Buffer.from("zcode-opencode-go-usage:v1", "utf8");

interface SecretsPayload {
  version: 1;
  keys: Record<string, string>;
}

interface DpapiEnvelope {
  version: 1;
  backend: "dpapi";
  blob: string;
}

interface AesEnvelope {
  version: 1;
  backend: "aes-gcm";
  iv: string;
  tag: string;
  data: string;
}

type Envelope = DpapiEnvelope | AesEnvelope;

export interface EnvKey {
  id: string;
  key: string;
  label: string;
  fingerprint: string;
}

/** Shape check only: we cannot verify a key without calling the upstream. */
export function assertKeyShape(raw: string): string {
  const key = raw.replace(/\r/g, "").replace(/\n/g, "").trim();
  if (key.length < 8 || key.length > 512) {
    throw new AppError("invalid_key", "API Key 长度不合法（应在 8–512 个字符之间）");
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    throw new AppError("invalid_key", "API Key 只能包含可见的 ASCII 字符");
  }
  return key;
}

export function fingerprint(key: string): string {
  return `${FINGERPRINT_PREFIX}${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16)}`;
}

function readSecretFromEnv(name: string): string | undefined {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Environment-provided accounts: OPENCODE_GO_API_KEY plus numbered _2.._9. */
export function envKeys(): EnvKey[] {
  const found: EnvKey[] = [];
  const base = readSecretFromEnv(KEY_ENV);
  if (base) {
    const key = assertKeyShape(base);
    found.push({
      id: "env_1",
      key,
      label: readSecretFromEnv(LABEL_ENV) ?? "环境变量账号",
      fingerprint: fingerprint(key),
    });
  }
  for (let index = 2; index <= 9; index += 1) {
    const name = `OPENCODE_GO_API_KEY_${index}`;
    if (!KEY_ENV_INDEXED.test(name)) continue;
    const value = readSecretFromEnv(name);
    if (!value) continue;
    const key = assertKeyShape(value);
    found.push({
      id: `env_${index}`,
      key,
      label: readSecretFromEnv(`OPENCODE_GO_LABEL_${index}`) ?? `环境变量账号 ${index}`,
      fingerprint: fingerprint(key),
    });
  }
  return found;
}

function runDpapi(op: "protect" | "unprotect", inputBase64: string): string {
  const script = path.join(bundleDir(), "dpapi.ps1");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, op],
    {
      input: inputBase64,
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new AppError(
      "credential_backend_failed",
      `Windows DPAPI 调用失败：${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || "").trim().slice(0, 200);
    throw new AppError(
      "credential_backend_failed",
      `Windows DPAPI 返回退出码 ${result.status}${detail ? `：${detail}` : ""}`,
    );
  }
  const output = (result.stdout || "").trim();
  if (!output) {
    throw new AppError("credential_backend_failed", "Windows DPAPI 返回了空结果");
  }
  return output;
}

/**
 * Host-side credential store.
 *
 * On Windows secrets are encrypted with DPAPI (CurrentUser scope), so the
 * ciphertext can only be decrypted by the same Windows account. Elsewhere an
 * AES-256-GCM key file with mode 0600 is used. The decrypted map exists only
 * in the MCP server process; no tool result, log line or panel payload
 * contains a key.
 */
export class CredentialStore {
  private readonly dataDir: string;
  private readonly secretsPath: string;
  private readonly keyPath: string;
  private keys = new Map<string, string>();
  private loaded = false;
  private backend: CredentialBackend;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.secretsPath = path.join(dataDir, SECRETS_FILE);
    this.keyPath = path.join(dataDir, KEY_FILE);
    this.backend = process.platform === "win32" ? "dpapi" : "aes-gcm";
  }

  get backendName(): CredentialBackend {
    return this.backend;
  }

  get filePath(): string {
    return this.secretsPath;
  }

  /** Load and decrypt the existing blob. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.loaded) return;
    const envelope = await readJsonFile<Envelope | null>(this.secretsPath, null);
    if (!envelope) {
      this.backend =
        process.platform === "win32" && this.probeDpapi() ? "dpapi" : "aes-gcm";
      this.loaded = true;
      return;
    }
    try {
      const payload =
        envelope.backend === "dpapi"
          ? this.decryptDpapi(envelope)
          : await this.decryptAes(envelope);
      const parsed = JSON.parse(payload) as SecretsPayload;
      for (const [id, key] of Object.entries(parsed.keys ?? {})) {
        if (typeof key === "string" && key) this.keys.set(id, key);
      }
      this.backend = envelope.backend;
      this.loaded = true;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "credentials_unreadable",
        `凭据文件无法解密（${envelope.backend}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  has(id: string): boolean {
    return this.keys.has(id);
  }

  get(id: string): string | undefined {
    return this.keys.get(id);
  }

  ids(): string[] {
    return [...this.keys.keys()];
  }

  async set(id: string, key: string): Promise<void> {
    this.keys.set(id, assertKeyShape(key));
    await this.persist();
  }

  async delete(id: string): Promise<void> {
    if (!this.keys.delete(id)) return;
    await this.persist();
  }

  private probeDpapi(): boolean {
    try {
      const probe = Buffer.from('{"probe":"ok"}', "utf8").toString("base64");
      const encrypted = runDpapi("protect", probe);
      const roundTrip = runDpapi("unprotect", encrypted);
      return roundTrip === probe;
    } catch {
      return false;
    }
  }

  private encryptDpapi(payload: string): Envelope {
    const input = Buffer.from(payload, "utf8").toString("base64");
    const blob = runDpapi("protect", input);
    return { version: 1, backend: "dpapi", blob };
  }

  private decryptDpapi(envelope: DpapiEnvelope): string {
    const plain = runDpapi("unprotect", envelope.blob);
    return Buffer.from(plain, "base64").toString("utf8");
  }

  private async aesKey(): Promise<Buffer> {
    try {
      const raw = (await fs.readFile(this.keyPath, "utf8")).trim();
      const key = Buffer.from(raw, "base64");
      if (key.length === 32) return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    const key = randomBytes(32);
    await writeTextAtomic(this.keyPath, `${key.toString("base64")}\n`, 0o600);
    return key;
  }

  private async encryptAes(payload: string): Promise<Envelope> {
    const key = await this.aesKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AES_AAD);
    const data = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      version: 1,
      backend: "aes-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      data: data.toString("base64"),
    };
  }

  private async decryptAes(envelope: AesEnvelope): Promise<string> {
    const key = await this.aesKey();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(AES_AAD);
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]);
    return plain.toString("utf8");
  }

  private async persist(): Promise<void> {
    this.saveQueue = this.saveQueue.then(async () => {
      const payload: SecretsPayload = {
        version: 1,
        keys: Object.fromEntries(this.keys),
      };
      const body = JSON.stringify(payload);
      const envelope =
        this.backend === "dpapi" ? this.encryptDpapi(body) : await this.encryptAes(body);
      await writeJsonAtomic(this.secretsPath, envelope);
    });
    return this.saveQueue;
  }
}
