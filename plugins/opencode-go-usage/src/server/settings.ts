import path from "node:path";
import {
  DEFAULT_SETTINGS,
  REFRESH_MAX_SECONDS,
  REFRESH_MIN_SECONDS,
} from "../shared/constants.js";
import type { LanguageSetting, Settings } from "../shared/types.js";
import { AppError } from "./errors.js";
import { clampNumber, readJsonFile, writeJsonAtomic } from "./files.js";

interface SettingsFile {
  version: 1;
  settings: Settings;
}

const LANGUAGES: LanguageSetting[] = ["auto", "zh-CN", "en-US"];

function normalize(input: Partial<Settings> | null | undefined, base: Settings): Settings {
  const next: Settings = { ...base };
  const refresh = clampNumber(input?.refreshSeconds, REFRESH_MIN_SECONDS, REFRESH_MAX_SECONDS);
  if (refresh !== null) next.refreshSeconds = refresh;

  const warning = clampNumber(input?.warningPercent, 50, 99);
  if (warning !== null) next.warningPercent = warning;

  const critical = clampNumber(input?.criticalPercent, 51, 100);
  if (critical !== null) next.criticalPercent = critical;

  if (next.criticalPercent <= next.warningPercent) {
    next.criticalPercent = Math.min(100, next.warningPercent + 1);
  }
  if (input?.language && LANGUAGES.includes(input.language)) {
    next.language = input.language;
  }
  return next;
}

export class SettingsStore {
  private readonly file: string;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "settings.json");
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    const parsed = await readJsonFile<SettingsFile>(this.file, {
      version: 1,
      settings: { ...DEFAULT_SETTINGS },
    });
    this.settings = normalize(parsed.settings, { ...DEFAULT_SETTINGS });
    this.loaded = true;
  }

  get(): Settings {
    return { ...this.settings };
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    if (!patch || typeof patch !== "object") {
      throw new AppError("invalid_settings", "设置内容不合法");
    }
    const run = this.queue.then(async () => {
      await this.init();
      this.settings = normalize(patch, this.settings);
      await writeJsonAtomic(this.file, { version: 1, settings: this.settings });
      return this.get();
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
