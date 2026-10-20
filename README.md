# ZCode Plugins

anqiwen 的 ZCode 插件市场。添加一次市场，即可安装这里的所有插件。

## 安装

1. 打开 ZCode 桌面端 → **设置 → 插件 → 插件市场**。
2. 点击 **添加 → 添加插件市场**。
3. 粘贴本仓库地址：

   ```text
   https://github.com/anqiwen/zcode-plugins
   ```

4. 在 **个人 → zcode-plugins** 中选择插件，点击 **安装**。

> 前置条件：这两个插件都通过 `node` 启动 MCP 服务，需要本机安装 **Node.js 20 或更高版本**。

## 插件

| 插件 | 版本 | 说明 |
| --- | --- | --- |
| [document-reviewer](plugins/document-reviewer/README.md) | 0.9.1 | 在对话中或侧栏阅读 Markdown、TXT、PDF、DOCX，选区批注后交给主 Agent 修改原文件 |
| [opencode-go-usage](plugins/opencode-go-usage/README.md) | 0.1.1 | OpenCode Go 订阅额度面板：多账号、5 小时/每周/每月进度、重置倒计时、定时刷新与额度预警 |

后续插件会加入同一个市场。

## 仓库结构

```text
.
├── marketplace.json                 # ZCode 插件市场清单
├── README.md
├── LICENSE
└── plugins/
    ├── document-reviewer/
    │   ├── .zcode-plugin/plugin.json
    │   ├── dist/                    # 构建产物（安装时直接使用，需提交）
    │   ├── skills/document-reviewer/SKILL.md
    │   ├── src/                     # TypeScript 源码
    │   ├── scripts/                 # 构建 / 校验 / 本地市场打包
    │   ├── assets/icon.png
    │   ├── package.json
    │   └── README.md
    └── opencode-go-usage/
        ├── .zcode-plugin/plugin.json
        ├── dist/                    # server / panel / cli / dpapi
        ├── src/                     # TypeScript 源码
        ├── scripts/                 # 构建 / 校验 / 本地市场打包
        ├── package.json
        └── README.md
```

## 新增插件

1. 把插件目录放到 `plugins/<plugin-name>/`，确保包含 `.zcode-plugin/plugin.json`。
2. 在根目录 `marketplace.json` 的 `plugins` 数组里增加一条，`source` 指向 `./plugins/<plugin-name>`。
3. 版本号、描述和图标写在该条目里；插件自身的清单保持独立。

## 开发 Document Reviewer

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
