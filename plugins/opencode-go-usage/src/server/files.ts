import { promises as fs } from "node:fs";
import path from "node:path";

export async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as T;
    return fallback;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

/** Write JSON through a sibling temp file so a crash cannot truncate the store. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function writeTextAtomic(
  file: string,
  body: string,
  mode = 0o600,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, body, { encoding: "utf8", mode });
  await fs.rename(tmp, file);
}

export function clampNumber(value: unknown, min: number, max: number): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.min(max, Math.max(min, Math.round(num)));
}

export function cleanLabel(value: unknown, maxLength = 60): string | null {
  if (typeof value !== "string") return null;
  // Drop control characters that could break terminal output or the panel.
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}
