import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@modelcontextprotocol/ext-apps";
import { Bridge } from "./bridge.js";
import { ReviewerApp } from "./App.js";
import type { DocumentInfo } from "../shared/types.js";

function applyTheme(theme: string | undefined): void {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

function Root() {
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingDocument, setPendingDocument] = useState<DocumentInfo | null>(null);

  useEffect(() => {
    let disposed = false;
    const app = new App(
      { name: "document-reviewer", version: "0.9.0" },
      { availableDisplayModes: ["inline", "fullscreen"] },
    );
    const bridgeInstance = new Bridge(app);

    app.ontoolresult = (params) => {
      const structured = params.structuredContent as
        | { ok?: boolean; data?: { document?: DocumentInfo } }
        | undefined;
      if (structured?.ok && structured.data?.document) {
        setPendingDocument(structured.data.document);
      }
    };
    app.onhostcontextchanged = (context) => {
      applyTheme(context.theme);
      bridgeInstance.refreshCapabilities();
    };

    (async () => {
      try {
        await app.connect();
        if (disposed) return;
        bridgeInstance.refreshCapabilities();
        applyTheme(app.getHostContext()?.theme);
        setBridge(bridgeInstance);
      } catch (connectError: any) {
        if (disposed) return;
        setError(connectError?.message || String(connectError));
      }
    })();

    return () => {
      disposed = true;
    };
  }, []);

  if (error) {
    return (
      <div className="boot error">
        <h2>无法连接 ZCode 宿主</h2>
        <p>{error}</p>
        <p className="tiny">
          请确认插件已在 ZCode Desktop 的本地工作区会话中启用，并从插件面板打开。
        </p>
      </div>
    );
  }

  if (!bridge) {
    return <div className="boot">正在连接 ZCode…</div>;
  }

  return <ReviewerApp bridge={bridge} pendingDocument={pendingDocument} />;
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Root />);
}
