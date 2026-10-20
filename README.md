# Document Reviewer for ZCode

在 ZCode 里打开 Markdown、TXT、PDF、DOCX 文档，选中文字添加批注，再把所有批注一次性交给主 Agent 修改原文件。

这是一个 **ZCode 插件市场仓库**：根目录的 `marketplace.json` 声明插件，插件本体位于 `plugins/document-reviewer/`。

## 安装

1. 打开 ZCode 桌面端 → **设置 → 插件 → 插件市场**。
2. 点击 **添加 → 添加插件市场**。
3. 粘贴本仓库地址：

   ```text
   https://github.com/anqiwen/zcode-document-reviewer
   ```

4. 在 **个人 → zcode-document-reviewer** 中找到 **Document Reviewer**，点击 **安装**。
5. 新建任务，输入「打开文档批注面板」或「审阅 docs/report.md」。

> 前置条件：本机需要安装 **Node.js 20 或更高版本**（插件的 MCP 服务通过 `node` 启动）。

## 功能

- 内联或侧栏打开文档，不离开对话
- Markdown（渲染 / 源码）、TXT、PDF（文本层选区、缩放）、DOCX（Mammoth 预览）
- 多批注、修改 / 删除 / 疑问三种意图、待定高亮与序号 pin
- 跨文件批注总览、搜索、筛选、复制为 Markdown
- 批注持久化、文件变更后的锚点重定位与发送前哈希校验
- 发送后每 5 秒检查文件变化，自动提示刷新

完整功能说明见 [plugins/document-reviewer/README.md](plugins/document-reviewer/README.md)。

## 仓库结构

```text
.
├── marketplace.json                 # ZCode 插件市场清单
├── README.md
├── LICENSE
└── plugins/
    └── document-reviewer/
        ├── .zcode-plugin/plugin.json
        ├── dist/                    # 构建产物（安装时直接使用，需提交）
        ├── skills/document-reviewer/SKILL.md
        ├── src/                     # TypeScript 源码
        ├── scripts/                 # 构建 / 校验 / 本地市场打包
        ├── assets/icon.png
        ├── package.json
        └── README.md
```

## 开发

```bash
cd plugins/document-reviewer
npm install
npm run build       # 重新生成 dist/
npm run validate    # 校验清单与构建产物
npm run stage       # 生成 dist/local-marketplace（本地调试用，不提交）
```

修改源码后需要重新 `npm run build` 并提交 `dist/`，ZCode 安装时不会执行构建。

## License

[MIT](LICENSE)
