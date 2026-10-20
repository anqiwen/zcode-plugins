import { App } from "@modelcontextprotocol/ext-apps";
import type { ToolEnvelope, ToolFailure } from "../shared/types.js";

export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export class PanelBridge {
  readonly app: App;

  constructor(app: App) {
    this.app = app;
  }

  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = await this.app.callServerTool({ name, arguments: args });
    const structured = result.structuredContent as
      | ToolEnvelope<T>
      | ToolFailure
      | undefined;
    if (structured && typeof structured === "object" && "ok" in structured) {
      if (!structured.ok) {
        throw new ToolError(structured.error.code, structured.error.message);
      }
      return structured.data;
    }
    if (result.isError) {
      const text = (result.content ?? [])
        .map((part: any) => (part?.type === "text" ? (part.text ?? "") : ""))
        .filter(Boolean)
        .join("\n");
      throw new ToolError("tool_failed", text || `${name} 调用失败`);
    }
    return structured as T;
  }

  theme(): "light" | "dark" {
    return this.app.getHostContext()?.theme === "light" ? "light" : "dark";
  }

  locale(): string {
    return this.app.getHostContext()?.locale ?? "zh-CN";
  }

  displayMode(): string {
    return this.app.getHostContext()?.displayMode ?? "inline";
  }

  async requestFullscreen(): Promise<void> {
    try {
      await this.app.requestDisplayMode({ mode: "fullscreen" });
    } catch {
      /* the host may refuse; the panel still works inline */
    }
  }
}
