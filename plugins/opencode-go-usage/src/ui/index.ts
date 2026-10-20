import { App } from "@modelcontextprotocol/ext-apps";
import { WINDOW_SHORT } from "../shared/constants.js";
import type {
  AccountView,
  Lang,
  LanguageSetting,
  PanelState,
  Settings,
  UsageWindow,
} from "../shared/types.js";
import { PanelBridge } from "./bridge.js";
import { t } from "./i18n.js";

type Child = Node | string | number | false | null | undefined | Child[];

type Props = Record<string, unknown> & {
  class?: string;
  dataset?: Record<string, string>;
  style?: string;
  text?: string;
};

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = String(value);
      else if (key === "dataset") Object.assign(node.dataset, value as Record<string, string>);
      else if (key === "style") node.setAttribute("style", String(value));
      else if (key === "text") node.textContent = String(value);
      else if (key.startsWith("on") && typeof value === "function") {
        node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else {
        node.setAttribute(key, String(value));
      }
    }
  }
  const append = (child: Child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) {
      for (const item of child) append(item);
      return;
    }
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  for (const child of children) append(child);
  return node;
}

interface UiState {
  phase: "connecting" | "ready" | "error";
  connectError: string | null;
  panel: PanelState | null;
  lang: Lang;
  busy: string | null;
  error: string | null;
  toast: string | null;
  settingsOpen: boolean;
  addOpen: boolean;
  editing: string | null;
  confirmRemove: string | null;
  settingsDraft: Settings | null;
}

const state: UiState = {
  phase: "connecting",
  connectError: null,
  panel: null,
  lang: "zh-CN",
  busy: null,
  error: null,
  toast: null,
  settingsOpen: false,
  addOpen: false,
  editing: null,
  confirmRemove: null,
  settingsDraft: null,
};

let bridge: PanelBridge | null = null;
let app: App | null = null;
let autoTimer = 0;
let toastTimer = 0;
let confirmTimer = 0;
let started = false;
const firedResets = new Set<string>();
const root = document.getElementById("root") as HTMLElement;

function resolveLang(setting: LanguageSetting | undefined): Lang {
  if (setting === "zh-CN" || setting === "en-US") return setting;
  const locale = bridge?.locale() ?? "zh-CN";
  return locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function applyTheme(theme: string | undefined): void {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function setToast(message: string): void {
  state.toast = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 2600);
  render();
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function applyPanel(panel: PanelState): void {
  state.panel = panel;
  state.lang = resolveLang(panel.settings.language);
  state.phase = "ready";
  state.connectError = null;
  state.error = null;
  state.busy = null;
  if (state.editing && !panel.accounts.some((account) => account.id === state.editing)) {
    state.editing = null;
  }
  restartAutoRefresh();
  render();
}

function restartAutoRefresh(): void {
  window.clearInterval(autoTimer);
  const seconds = state.panel?.settings.refreshSeconds ?? 300;
  autoTimer = window.setInterval(() => {
    if (document.hidden || state.busy) return;
    if (state.editing || state.settingsOpen) return;
    void refresh(false);
  }, seconds * 1000);
}

async function refresh(force: boolean, accountId?: string): Promise<void> {
  if (!bridge || state.busy) return;
  state.busy = accountId ?? "all";
  state.error = null;
  render();
  try {
    const panel = await bridge.call<PanelState>(
      force ? "refresh_usage" : "get_panel_state",
      accountId ? { accountId } : {},
    );
    applyPanel(panel);
  } catch (error) {
    state.busy = null;
    state.error = describe(error);
    render();
  }
}

async function mutate(task: () => Promise<PanelState>): Promise<void> {
  if (state.busy) return;
  state.busy = "mutation";
  state.error = null;
  render();
  try {
    applyPanel(await task());
  } catch (error) {
    state.busy = null;
    state.error = describe(error);
    render();
  }
}

async function importEnvAccounts(): Promise<void> {
  if (state.busy || !bridge) return;
  state.busy = "mutation";
  state.error = null;
  render();
  try {
    const result = await bridge.call<{
      state: PanelState;
      imported: number;
      skipped: number;
    }>("import_env_accounts", {});
    applyPanel(result.state);
    const message = t(state.lang, "imported", { n: result.imported });
    const skipped =
      result.skipped > 0
        ? ` · ${t(state.lang, "importSkipped", { n: result.skipped })}`
        : "";
    setToast(`${message}${skipped}`);
  } catch (error) {
    state.busy = null;
    state.error = describe(error);
    render();
  }
}

function formatPercent(percent: number | null): string {
  if (percent === null) return "—";
  const rounded = Math.round(percent * 10) / 10;
  return `${rounded}%`;
}

function formatRemaining(seconds: number | null, lang: Lang): string {
  if (seconds === null || !Number.isFinite(seconds)) return t(lang, "noReset");
  if (seconds <= 0) return t(lang, "resetNow");
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

function remainingFor(window: UsageWindow): number | null {
  if (window.resetsAt) {
    const ms = Date.parse(window.resetsAt);
    if (Number.isFinite(ms)) return Math.max(0, Math.floor((ms - Date.now()) / 1000));
  }
  return window.resetsInSeconds;
}

function levelOf(percent: number | null, settings: Settings): "ok" | "warn" | "critical" {
  if (percent === null) return "ok";
  if (percent >= settings.criticalPercent) return "critical";
  if (percent >= settings.warningPercent) return "warn";
  return "ok";
}

function timeLabel(ms: number | null | undefined, lang: Lang): string {
  if (!ms) return t(lang, "neverUpdated");
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return date.toLocaleString(lang, {
    hour12: false,
    ...(sameDay
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
  });
}

function backendLabel(panel: PanelState): string {
  if (panel.security.credentialBackend === "dpapi") {
    return t(state.lang, "credentialDpapi");
  }
  return t(state.lang, "credentialAes");
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    setToast(t(state.lang, "copied"));
    return;
  } catch {
    /* clipboard permission is optional; fall through to the legacy path */
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    document.execCommand("copy");
    setToast(t(state.lang, "copied"));
  } catch {
    setToast(text);
  } finally {
    area.remove();
  }
}

function cliCommand(panel: PanelState): string {
  return `"${panel.security.nodePath}" "${panel.security.cliPath}" add --data-dir "${panel.security.dataDir}"`;
}

function windowRow(window: UsageWindow, settings: Settings, lang: Lang): HTMLElement {
  const percent = window.percent;
  const level = levelOf(percent, settings);
  const width = percent === null ? 0 : Math.max(0, Math.min(100, percent));
  const seconds = remainingFor(window);
  const resetLabel = window.resetsAt
    ? h(
        "span",
        { dataset: { resetsAt: window.resetsAt } },
        formatRemaining(seconds, lang),
      )
    : t(lang, "resetUnknown");
  return h(
    "div",
    { class: `win level-${level}` },
    h(
      "div",
      { class: "win-head" },
      h("span", { class: "win-label" }, WINDOW_SHORT[lang][window.key] ?? window.key),
      h("span", { class: "win-pct" }, formatPercent(percent)),
    ),
    h(
      "div",
      {
        class: "bar",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(width)),
        "aria-label": `${WINDOW_SHORT[lang][window.key]} ${formatPercent(percent)}`,
      },
      h("div", { class: "bar-fill", style: `width:${width}%` }),
      settings.warningPercent < 100
        ? h("div", {
            class: "bar-marker",
            style: `left:${Math.min(99, settings.warningPercent)}%`,
            title: `${settings.warningPercent}%`,
          })
        : null,
    ),
    h("div", { class: "win-foot" }, `${t(lang, "resetsIn")} `, resetLabel),
  );
}

function accountActions(account: AccountView): HTMLElement {
  const lang = state.lang;
  const busy = Boolean(state.busy);
  if (account.source === "env") {
    return h(
      "div",
      { class: "account-actions" },
      h(
        "button",
        {
          class: "ghost",
          disabled: busy,
          title: t(lang, "refreshAccount"),
          onClick: () => void refresh(true, account.id),
        },
        t(lang, "refreshAccount"),
      ),
    );
  }
  if (state.editing === account.id) {
    return h("div", { class: "account-actions" }, h("span", { class: "mini" }, lang === "zh-CN" ? "编辑中" : "Editing"));
  }
  return h(
    "div",
    { class: "account-actions" },
    h(
      "button",
      {
        class: "ghost",
        disabled: busy,
        onClick: () => void refresh(true, account.id),
      },
      t(lang, "refreshAccount"),
    ),
    h(
      "button",
      {
        class: "ghost",
        disabled: busy,
        onClick: () => {
          state.editing = account.id;
          render();
        },
      },
      t(lang, "rename"),
    ),
    h(
      "button",
      {
        class: `ghost ${account.enabled ? "" : "on"}`,
        disabled: busy,
        onClick: () =>
          void mutate(() =>
            bridge!.call<PanelState>("set_account_enabled", {
              id: account.id,
              enabled: !account.enabled,
            }),
          ),
      },
      account.enabled ? t(lang, "disable") : t(lang, "enable"),
    ),
    h(
      "button",
      {
        class: `ghost danger ${state.confirmRemove === account.id ? "confirm" : ""}`,
        disabled: busy,
        onClick: () => {
          if (state.confirmRemove === account.id) {
            state.confirmRemove = null;
            window.clearTimeout(confirmTimer);
            void mutate(() =>
              bridge!.call<PanelState>("remove_account", { id: account.id }),
            );
            return;
          }
          state.confirmRemove = account.id;
          window.clearTimeout(confirmTimer);
          confirmTimer = window.setTimeout(() => {
            state.confirmRemove = null;
            render();
          }, 4000);
          render();
        },
      },
      state.confirmRemove === account.id ? t(lang, "confirmRemove") : t(lang, "remove"),
    ),
  );
}

function renameEditor(account: AccountView): HTMLElement {
  const input = h("input", {
    class: "rename-input",
    value: account.label,
    maxlength: "60",
    placeholder: t(state.lang, "editLabelPlaceholder"),
  });
  const submit = () => {
    const label = input.value.trim();
    if (!label) return;
    state.editing = null;
    void mutate(() =>
      bridge!.call<PanelState>("rename_account", { id: account.id, label }),
    );
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submit();
    if (event.key === "Escape") {
      state.editing = null;
      render();
    }
  });
  window.setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return h(
    "div",
    { class: "rename-row" },
    input,
    h("button", { class: "primary small", onClick: submit }, t(state.lang, "save")),
    h(
      "button",
      {
        class: "ghost small",
        onClick: () => {
          state.editing = null;
          render();
        },
      },
      t(state.lang, "cancel"),
    ),
  );
}

function accountCard(account: AccountView): HTMLElement {
  const lang = state.lang;
  const settings = state.panel!.settings;
  const usage = account.usage;
  const hasWindows = Boolean(usage && usage.windows.length > 0);
  const error = usage?.error;
  const updated =
    usage && usage.fetchedAt ? timeLabel(usage.fetchedAt, lang) : t(lang, "neverUpdated");
  const badge =
    account.source === "env" ? t(lang, "envBadge") : t(lang, "storeBadge");
  return h(
    "section",
    { class: `account ${account.enabled ? "" : "is-disabled"}` },
    h(
      "div",
      { class: "account-head" },
      h(
        "div",
        { class: "account-title" },
        h("span", {
          class: `dot ${error ? "dot-warn" : account.enabled ? "dot-ok" : "dot-off"}`,
        }),
        h("span", { class: "account-name" }, account.label),
        h("span", { class: `badge ${account.source === "env" ? "badge-env" : ""}` }, badge),
        account.enabled ? null : h("span", { class: "badge badge-off" }, t(lang, "disabled")),
      ),
      accountActions(account),
    ),
    state.editing === account.id
      ? renameEditor(account)
      : h(
          "div",
          { class: "account-meta" },
          h("code", { class: "fp" }, account.fingerprint),
          h("span", { class: "sep" }, "·"),
          h("span", null, t(lang, "updatedAt", { time: updated })),
          error && hasWindows
            ? h("span", { class: "tag warn" }, t(lang, "stale"))
            : null,
        ),
    account.enabled && hasWindows
      ? h(
          "div",
          { class: "windows" },
          usage!.windows.map((window) => windowRow(window, settings, lang)),
        )
      : null,
    !account.enabled
      ? h("div", { class: "notice muted" }, t(lang, "disabled"))
      : error
        ? h(
            "div",
            { class: "notice error" },
            h(
              "span",
              null,
              `${t(lang, "queryFailed")}：${error.message}${hasWindows ? ` · ${t(lang, "stale")}` : ""}`,
            ),
            h(
              "button",
              {
                class: "ghost small",
                disabled: Boolean(state.busy),
                onClick: () => void refresh(true, account.id),
              },
              t(lang, "retry"),
            ),
          )
        : !hasWindows
          ? h("div", { class: "notice muted" }, t(lang, "noData"))
          : null,
  );
}

function warningBanner(panel: PanelState): HTMLElement | null {
  if (panel.warnings.length === 0) return null;
  const critical = panel.warnings.some((warning) => warning.level === "critical");
  const top = panel.warnings.slice(0, 3);
  return h(
    "div",
    { class: `banner ${critical ? "banner-critical" : "banner-warn"}` },
    h("div", { class: "banner-title" }, t(state.lang, "warningTitle")),
    h(
      "ul",
      { class: "banner-list" },
      top.map((warning) =>
        h(
          "li",
          null,
          t(state.lang, "warningLine", {
            account: warning.accountLabel,
            window: WINDOW_SHORT[state.lang][warning.window],
            percent: formatPercent(warning.percent),
          }),
          warning.level === "critical"
            ? h("span", { class: "tag danger" }, t(state.lang, "criticalTag"))
            : null,
        ),
      ),
      panel.warnings.length > top.length
        ? h("li", { class: "more" }, `+${panel.warnings.length - top.length}`)
        : null,
    ),
  );
}

function settingsPanel(panel: PanelState): HTMLElement {
  const lang = state.lang;
  const draft = state.settingsDraft ?? panel.settings;
  const intervalOptions = [60, 300, 900, 1800, 3600];
  if (!intervalOptions.includes(draft.refreshSeconds)) {
    intervalOptions.push(draft.refreshSeconds);
    intervalOptions.sort((a, b) => a - b);
  }
  const select = h(
    "select",
    { class: "input" },
    intervalOptions.map((seconds) =>
      h(
        "option",
        { value: String(seconds), selected: seconds === draft.refreshSeconds ? "true" : null },
        seconds < 60
          ? t(lang, "everySeconds", { n: seconds })
          : t(lang, "everyMinutes", { n: Math.round(seconds / 60) }),
      ),
    ),
  );
  const warning = h("input", {
    class: "input",
    type: "number",
    min: "50",
    max: "99",
    value: String(draft.warningPercent),
  });
  const critical = h("input", {
    class: "input",
    type: "number",
    min: "51",
    max: "100",
    value: String(draft.criticalPercent),
  });
  const language = h(
    "select",
    { class: "input" },
    h(
      "option",
      { value: "auto", selected: draft.language === "auto" ? "true" : null },
      t(lang, "languageAuto"),
    ),
    h(
      "option",
      { value: "zh-CN", selected: draft.language === "zh-CN" ? "true" : null },
      "中文",
    ),
    h(
      "option",
      { value: "en-US", selected: draft.language === "en-US" ? "true" : null },
      "English",
    ),
  );
  const warningValue = Number(warning.value);
  const criticalValue = Number(critical.value);
  const valid = Number.isFinite(warningValue) && Number.isFinite(criticalValue) && criticalValue > warningValue;

  const save = () => {
    const warn = Number(warning.value);
    const crit = Number(critical.value);
    if (!Number.isFinite(warn) || !Number.isFinite(crit) || crit <= warn) {
      setToast(lang === "zh-CN" ? "严重阈值必须大于预警阈值" : "Critical must exceed warning");
      return;
    }
    state.settingsOpen = false;
    state.settingsDraft = null;
    void mutate(async () => {
      const next = await bridge!.call<PanelState>("update_settings", {
        refreshSeconds: Number(select.value),
        warningPercent: Math.round(warn),
        criticalPercent: Math.round(crit),
        language: language.value as LanguageSetting,
      });
      setToast(t(state.lang, "saved"));
      return next;
    });
  };

  return h(
    "section",
    { class: "sheet" },
    h(
      "div",
      { class: "sheet-head" },
      h("h2", null, t(lang, "settingsTitle")),
      h(
        "button",
        {
          class: "ghost small",
          onClick: () => {
            state.settingsOpen = false;
            state.settingsDraft = null;
            render();
          },
        },
        t(lang, "close"),
      ),
    ),
    h(
      "div",
      { class: "form-grid" },
      h("label", null, t(lang, "refreshInterval"), select),
      h("label", null, `${t(lang, "warningThreshold")} (%)`, warning),
      h("label", null, `${t(lang, "criticalThreshold")} (%)`, critical),
      h("label", null, t(lang, "language"), language),
    ),
    h("p", { class: "note" }, t(lang, "securityNote", { backend: backendLabel(panel) })),
    h(
      "div",
      { class: "sheet-actions" },
      h("button", { class: "primary", disabled: !valid, onClick: save }, t(lang, "saveSettings")),
    ),
  );
}

function addPanel(panel: PanelState): HTMLElement {
  const lang = state.lang;
  const command = cliCommand(panel);
  return h(
    "section",
    { class: "sheet" },
    h(
      "div",
      { class: "sheet-head" },
      h("h2", null, t(lang, "addTitle")),
      h(
        "button",
        {
          class: "ghost small",
          onClick: () => {
            state.addOpen = false;
            render();
          },
        },
        t(lang, "close"),
      ),
    ),
    h("p", { class: "note" }, t(lang, "addIntro")),
    h("p", { class: "step" }, t(lang, "step1")),
    h(
      "div",
      { class: "code-row" },
      h("code", { class: "command" }, command),
      h("button", { class: "primary small", onClick: () => void copyText(command) }, t(lang, "copy")),
    ),
    h("p", { class: "step" }, t(lang, "step2")),
    h("p", { class: "step" }, t(lang, "step3")),
    h(
      "div",
      { class: "sheet-actions" },
      h(
        "button",
        {
          class: "primary",
          disabled: Boolean(state.busy),
          onClick: () => {
            state.addOpen = false;
            void refresh(false);
          },
        },
        t(lang, "refreshAccounts"),
      ),
      h(
        "button",
        {
          class: "ghost",
          disabled: Boolean(state.busy),
          onClick: () => void importEnvAccounts(),
        },
        t(lang, "importEnv"),
      ),
    ),
    h("p", { class: "note mini" }, t(lang, "envHint")),
    h("p", { class: "note mini" }, t(lang, "securityNote", { backend: backendLabel(panel) })),
  );
}

function emptyState(panel: PanelState): HTMLElement {
  const lang = state.lang;
  return h(
    "section",
    { class: "empty" },
    h("div", { class: "empty-mark" }, "5h"),
    h("h2", null, t(lang, "noAccounts")),
    h("p", { class: "note" }, t(lang, "noAccountsHint")),
    h(
      "div",
      { class: "code-row" },
      h("code", { class: "command" }, cliCommand(panel)),
      h(
        "button",
        { class: "primary small", onClick: () => void copyText(cliCommand(panel)) },
        t(lang, "copy"),
      ),
    ),
    h(
      "div",
      { class: "sheet-actions" },
      h(
        "button",
        {
          class: "primary",
          disabled: Boolean(state.busy),
          onClick: () => void refresh(false),
        },
        t(lang, "refreshAccounts"),
      ),
      h(
        "button",
        {
          class: "ghost",
          disabled: Boolean(state.busy),
          onClick: () => void importEnvAccounts(),
        },
        t(lang, "importEnv"),
      ),
    ),
    h("p", { class: "note mini" }, t(lang, "envHint")),
    h("p", { class: "note mini" }, t(lang, "securityNote", { backend: backendLabel(panel) })),
  );
}

function header(panel: PanelState | null): HTMLElement {
  const lang = state.lang;
  const count = panel?.accounts.length ?? 0;
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "brand" },
      h("span", { class: "brand-mark" }, "GO"),
      h(
        "div",
        { class: "brand-text" },
        h("h1", null, t(lang, "title")),
        h("p", null, t(lang, "subtitle", { count })),
      ),
    ),
    h(
      "div",
      { class: "top-actions" },
      h(
        "button",
        {
          class: `ghost ${state.busy === "all" ? "busy" : ""}`,
          disabled: Boolean(state.busy) || !panel,
          onClick: () => void refresh(true),
          title: t(lang, "refresh"),
        },
        state.busy === "all" ? "…" : t(lang, "refresh"),
      ),
      h(
        "button",
        {
          class: "ghost",
          disabled: !panel,
          onClick: () => {
            state.addOpen = !state.addOpen;
            state.settingsOpen = false;
            render();
          },
        },
        t(lang, "addAccount"),
      ),
      h(
        "button",
        {
          class: "ghost",
          disabled: !panel,
          onClick: () => {
            state.settingsOpen = !state.settingsOpen;
            state.addOpen = false;
            state.settingsDraft = panel ? { ...panel.settings } : null;
            render();
          },
        },
        t(lang, "settings"),
      ),
    ),
  );
}

function footer(panel: PanelState): HTMLElement {
  const lang = state.lang;
  const seconds = panel.settings.refreshSeconds;
  const amount =
    seconds < 60
      ? t(lang, "secondsShort", { n: seconds })
      : t(lang, "minutesShort", { n: Math.round(seconds / 60) });
  const auto = t(lang, "footerAuto", { n: amount });
  return h(
    "footer",
    { class: "foot" },
    h("span", null, auto),
    h("span", { class: "sep" }, "·"),
    h("span", null, t(lang, "footerUpdated", { time: timeLabel(panel.generatedAt, lang) })),
    h("span", { class: "sep" }, "·"),
    h("span", { class: "backend" }, backendLabel(panel)),
    h(
      "button",
      {
        class: "ghost tiny",
        onClick: () => void bridge?.requestFullscreen(),
        title: t(lang, "fullscreen"),
      },
      t(lang, "expand"),
    ),
  );
}

function mainBody(panel: PanelState | null): HTMLElement {
  const lang = state.lang;
  if (state.phase === "connecting") {
    return h("div", { class: "center" }, t(lang, "loading"));
  }
  if (state.phase === "error" || !panel) {
    return h(
      "div",
      { class: "center error" },
      h("h2", null, t(lang, "clientError")),
      h("p", null, state.connectError ?? ""),
      h("p", { class: "note" }, t(lang, "clientErrorHint")),
    );
  }
  const sections: Child[] = [];
  const banner = warningBanner(panel);
  if (banner) sections.push(banner);
  if (state.error) {
    sections.push(
      h(
        "div",
        { class: "notice error" },
        `${t(lang, "errorTitle")}：${state.error}`,
        h(
          "button",
          { class: "ghost small", onClick: () => void refresh(false) },
          t(lang, "retry"),
        ),
      ),
    );
  }
  if (state.settingsOpen) sections.push(settingsPanel(panel));
  if (state.addOpen) sections.push(addPanel(panel));
  if (panel.accounts.length === 0) {
    sections.push(emptyState(panel));
  } else {
    sections.push(...panel.accounts.map((account) => accountCard(account)));
  }
  return h("div", { class: "body" }, sections);
}

function render(): void {
  const panel = state.panel;
  const scroller = document.scrollingElement ?? document.documentElement;
  const scrollTop = scroller.scrollTop;
  const shell = h(
    "div",
    { class: `app display-${bridge?.displayMode() ?? "inline"}` },
    header(panel),
    mainBody(panel),
    panel ? footer(panel) : null,
    state.toast ? h("div", { class: "toast" }, state.toast) : null,
  );
  root.replaceChildren(shell);
  scroller.scrollTop = scrollTop;
}

function tick(): void {
  const nodes = document.querySelectorAll<HTMLElement>("[data-resets-at]");
  let needsRefresh = false;
  nodes.forEach((node) => {
    const iso = node.dataset.resetsAt;
    if (!iso) return;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return;
    const seconds = Math.max(0, Math.floor((ms - Date.now()) / 1000));
    const text = formatRemaining(seconds, state.lang);
    if (node.textContent !== text) node.textContent = text;
    if (seconds <= 0 && !firedResets.has(iso)) {
      firedResets.add(iso);
      needsRefresh = true;
    }
  });
  if (needsRefresh && !state.busy) void refresh(true);
}

async function bootstrap(): Promise<void> {
  if (started) return;
  started = true;
  state.phase = "connecting";
  render();
  try {
    app = new App(
      { name: "opencode-go-usage", version: "0.1.1" },
      { availableDisplayModes: ["inline", "fullscreen"] },
    );
    bridge = new PanelBridge(app);
    app.onhostcontextchanged = (context) => {
      applyTheme(context.theme);
      if (state.panel) {
        state.lang = resolveLang(state.panel.settings.language);
        render();
      }
    };
    app.ontoolresult = (params) => {
      const structured = params.structuredContent as
        | { ok?: boolean; data?: Partial<PanelState> }
        | undefined;
      if (structured?.ok && structured.data?.accounts && structured.data.settings) {
        applyPanel(structured.data as PanelState);
      }
    };
    await app.connect();
    applyTheme(app.getHostContext()?.theme);
    const panel = await bridge.call<PanelState>("get_panel_state", {});
    applyPanel(panel);
  } catch (error) {
    state.phase = "error";
    state.connectError = describe(error);
    render();
  }
}

window.setInterval(tick, 1000);
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.editing) {
    state.editing = null;
    render();
    return;
  }
  if (state.settingsOpen || state.addOpen) {
    state.settingsOpen = false;
    state.addOpen = false;
    state.settingsDraft = null;
    render();
  }
});
window.addEventListener("unhandledrejection", (event) => {
  setToast(describe(event.reason));
});

void bootstrap();
