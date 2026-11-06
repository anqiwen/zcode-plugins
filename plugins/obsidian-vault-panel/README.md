# Obsidian Vault Panel — ZCode UI Plugin

在 ZCode 桌面端的会话侧栏中，直接浏览、实时预览式编辑、新建与删除本机 Obsidian Vault 里的 Markdown 笔记。

> 本插件基于 ZCode 的 UI Plugin 契约（`ui.surfaces` + `text/html;profile=mcp-app`）与 CodeMirror 6 开发，实现文件级读写与原地实时渲染。

## 特性

- **自动发现 Vault**：自动解析本机 `%APPDATA%\obsidian\obsidian.json` 中的全部库（按最近打开智能排前）。
- **Obsidian 质感 Live Preview**：基于 CodeMirror 6 自研原地渲染引擎，打字时标题、加粗、代码块、双链（Wikilink）、嵌入等即时渲染；光标所在行自动还原展示 Markdown 原始标记（支持一键切换「实时预览 / 源码」模式）。
- **清爽目录树与一键折叠**：
  - 默认全部收起，避免多文件夹库一打开铺满屏幕；
  - 搜索栏右侧提供「全部折叠 ︽」与「全部展开 ︾」一键按钮；
  - 打开或新建笔记时智能递归展开其父文件夹链路。
- **新建与删除管理**：
  - 顶栏支持在库根目录新建笔记（`＋ 笔记`）与新建文件夹（`📁 文件夹`，支持多级路径）；
  - 树节点悬停快捷新建子笔记、新建子文件夹；
  - 树节点悬停垃圾桶 `🗑️` 或当前打开笔记的右上角工具栏「删除」按钮，带二次确认模态弹窗与防误删校验。
- **安全与冲突守卫**：
  - 路径越界安全校验（禁止超出当前 Vault 根目录）；
  - 基于文件修改时间戳（mtime）的乐观锁：若笔记已在外部 Obsidian 窗口中被修改，拒绝静默覆盖并提示回读。
- **独立模态对话框**：针对 ZCode 插件沙箱禁用原生 `window.prompt/confirm` 的限制，内置纯 HTML/CSS 优雅毛玻璃交互弹窗。
- **侧边栏拖拽与折叠**：支持侧边栏 ☰ 一键收起与 160–520px 任意拖拽调宽，状态跨会话持久化记忆。
- **全源单文件内联**：CSS、JS 与 Lucide 风格 SVG 矢量图标全量内联打包，严格适配沙箱 CSP 与离线环境。

## 工具列表

| 工具 | 权限 | 说明 |
|---|---|---|
| `open_vault_panel` | 模型 / 页面 | 打开会话侧栏的 Obsidian 笔记面板并列出已发现的 Vault |
| `list_vaults` | 页面专有 | 列出本机已登记的全部 Vault 详细信息 |
| `list_notes` | 页面专有 | 获取指定 Vault 的完整 Markdown 目录树 |
| `read_note` | 页面专有 | 读取一篇 Markdown 笔记的正文与时间戳 |
| `write_note` | 页面专有 | 写回笔记（支持 mtime 乐观锁） |
| `create_note` | 页面专有 | 新建笔记（自动补全父目录） |
| `create_folder` | 页面专有 | 新建多级文件夹 |
| `delete_note` | 页面专有 | 彻底从磁盘删除指定笔记 |
| `search_notes` | 页面专有 | Vault 内 Markdown 全文大小写不敏感检索 |

## 安装与使用

通过 `zcode-plugins` 市场安装：

### 插件市场安装

1. 打开 ZCode **设置 → 插件 → 插件市场 → 添加 → 添加插件市场**。
2. 填入：
   ```text
   https://github.com/anqiwen/zcode-plugins
   ```
3. 在市场列表中找到「**Obsidian 笔记 (Obsidian Vault Panel)**」，点击安装。
4. **新建会话**（`Ctrl+N`）或重启 ZCode 生效。
5. 在会话中输入或对 Agent 说：
   > 打开 Obsidian 笔记面板

### 快捷键提示

- 切换右侧面板（本面板所在侧栏）：`Ctrl+Alt+B`
- 进出全屏完整视图：`Ctrl+Shift+F`
- 面板内折叠/展开文件树：点顶栏 `☰` 图标
- 保存当前笔记：`Ctrl+S`

## 本地构建

```bash
npm install
npm run build
npm run test:server
```

## 开源协议

MIT License
