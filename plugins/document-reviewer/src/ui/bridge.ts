import { App } from "@modelcontextprotocol/ext-apps";
import type { Result } from "../shared/types.js";

const PANEL_URI = "ui://document-reviewer/panel.html";
const ASSET_PREFIX = "ui://document-reviewer/assets/";

export class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface BridgeCapabilities {
  message: boolean;
  updateModelContext: boolean;
  widgetState: boolean;
  resourceSubscribe: boolean;
  surfaceId?: string;
}

export class Bridge {
  readonly app: App;
  private assetCache = new Map<string, Promise<Uint8Array>>();
  private textAssetCache = new Map<string, Promise<string>>();
  capabilities: BridgeCapabilities = {
    message: false,
    updateModelContext: false,
    widgetState: false,
    resourceSubscribe: false,
  };

  constructor(app: App) {
    this.app = app;
  }

  refreshCapabilities(): void {
    const caps = this.app.getHostCapabilities() as
      | (Record<string, unknown> & { experimental?: Record<string, unknown> })
      | undefined;
    const experimental = (caps?.experimental ?? {}) as Record<string, unknown>;
    this.capabilities = {
      message: Boolean(caps?.message),
      updateModelContext: Boolean(caps?.updateModelContext),
      widgetState: Boolean(experimental["zcode/widgetState"]),
      resourceSubscribe: Boolean(experimental["zcode/resourceSubscribe"]),
      surfaceId: (experimental["zcode/surface"] as { id?: string } | undefined)?.id,
    };
  }

  theme(): "light" | "dark" {
    const theme = this.app.getHostContext()?.theme;
    return theme === "light" ? "light" : "dark";
  }

  locale(): string {
    return this.app.getHostContext()?.locale ?? "zh-CN";
  }

  displayMode(): "inline" | "fullscreen" | "pip" {
    const mode = this.app.getHostContext()?.displayMode;
    return mode === "inline" || mode === "pip" ? mode : "fullscreen";
  }

  async requestFullscreen(): Promise<void> {
    try {
      await this.app.requestDisplayMode({ mode: "fullscreen" });
    } catch {
      /* the host may not allow changing the mode from this surface */
    }
  }

  async callTool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.app.callServerTool({ name, arguments: args });
    const structured = result.structuredContent as Result<T> | undefined;
    if (structured && typeof structured === "object" && "ok" in structured) {
      if (!structured.ok) {
        throw new ToolError(structured.error.code, structured.error.message);
      }
      return structured.data;
    }
    if (result.isError) {
      const text = (result.content ?? [])
        .filter((part: any) => part?.type === "text")
        .map((part: any) => part.text)
        .join("\n");
      throw new ToolError("tool_failed", text || `${name} 调用失败`);
    }
    return structured as T;
  }

  async readResource(uri: string): Promise<Record<string, any>> {
    const result = await this.app.readServerResource({ uri });
    const contents = result.contents?.[0];
    if (!contents) throw new ToolError("empty_resource", `资源为空：${uri}`);
    return contents as Record<string, any>;
  }

  readAsset(name: string): Promise<Uint8Array> {
    const cached = this.assetCache.get(name);
    if (cached) return cached;
    const task = this.readResource(`${ASSET_PREFIX}${name}`).then((contents) => {
      if (typeof contents.blob === "string") return base64ToBytes(contents.blob);
      if (typeof contents.text === "string") return new TextEncoder().encode(contents.text);
      throw new ToolError("bad_asset", `资源格式不支持：${name}`);
    });
    this.assetCache.set(name, task);
    task.catch(() => this.assetCache.delete(name));
    return task;
  }

  readTextAsset(name: string): Promise<string> {
    const cached = this.textAssetCache.get(name);
    if (cached) return cached;
    const task = this.readResource(`${ASSET_PREFIX}${name}`).then((contents) => {
      if (typeof contents.text === "string") return contents.text;
      if (typeof contents.blob === "string") {
        return new TextDecoder().decode(base64ToBytes(contents.blob));
      }
      throw new ToolError("bad_asset", `资源格式不支持：${name}`);
    });
    this.textAssetCache.set(name, task);
    task.catch(() => this.textAssetCache.delete(name));
    return task;
  }

  async sendMessage(text: string): Promise<void> {
    await this.app.sendMessage({
      role: "user",
      content: [{ type: "text", text }],
    });
  }

  async updateModelContext(text: string, structuredContent?: Record<string, unknown>): Promise<void> {
    await this.app.updateModelContext({
      content: [{ type: "text", text }],
      ...(structuredContent ? { structuredContent } : {}),
    });
  }

  async setWidgetState(state: Record<string, unknown>): Promise<void> {
    if (!this.capabilities.widgetState) return;
    try {
      await this.app.request(
        { method: "ui/set-widget-state", params: { widgetState: state } },
        // Minimal schema: the host validates the envelope.
        { parse: (value: unknown) => value } as any,
      );
    } catch {
      /* widget state is best-effort */
    }
  }

  panelUri(): string {
    return PANEL_URI;
  }
}
