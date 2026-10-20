# OpenCode Go Usage — ZCode UI Plugin

在 ZCode 对话里以独立面板查看 OpenCode Go 订阅额度：多账号、5 小时滚动窗口 / 每周 / 每月三条进度、重置倒计时、手动与定时刷新、额度预警。

> 第一版是**独立 UI 面板**（`ui.surfaces` + 工具内联卡片）。ZCode 的扩展 API 没有底部常驻状态栏/底栏槽位，因此没有做常驻徽章；面板由 Agent 调用工具或从插件面板打开。

## 已验证的接口

```
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <OPENCODE_GO_API_KEY>
```

2026-10-20 用当前 OpenCode Go 账号实测返回 `200`：

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 1, "resetsAt": "2026-10-20T10:59:37.000Z" },
    "weekly":  { "status": "ok", "percent": 4, "resetsAt": "2026-10-26T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 88, "resetsAt": "2026-10-21T14:13:42.000Z" }
  }
}
```

`percent` 是**已用**百分比，`resetsAt` 是 ISO 重置时刻。该接口不是 OpenCode 官方公开文档的一部分（社区发现），响应结构可能变化；插件对 `usage.` 前缀/裸窗口、`resetsAt`/`resets_at`/`resetsInSeconds` 都做了兼容解析，窗口缺失时逐项跳过而不是整体失败。

## 功能

- **多账号**：本地加密凭据库中的账号 + `OPENCODE_GO_API_KEY_2…_9` 环境变量账号，按 Key 指纹去重。
- **三条额度进度**：5 小时滚动、每周、每月；显示已用百分比、进度条、预警阈值刻度线。
- **重置倒计时**：按 `resetsAt` 每秒刷新；归零后自动触发一次刷新。
- **刷新**：手动刷新全部、单账号「检测」、按设置间隔自动刷新（60–3600 秒，面板可见时生效）。
- **额度预警**：可配置预警/严重阈值（默认 80% / 95%），顶部横幅 + 窗口着色。
- **中英双语**：跟随 ZCode locale，也可在设置里固定中文/English。
- **深/浅色**：跟随宿主主题。

## 安装

通过 `zcode-plugins` 市场安装：

### 插件市场（推荐）

1. 打开 **设置 → 插件 → 插件市场 → 添加 → 添加插件市场**。
2. 粘贴：

   ```text
   https://github.com/anqiwen/zcode-plugins
   ```

3. 在 **个人 → zcode-plugins** 中找到「OpenCode Go 用量」，点击安装。
4. **新建任务**后生效（旧会话不热加载）。

### 本地开发

源码在本目录。构建后用本地市场调试：

```sh
npm install
npm run build
npm run stage   # 生成 dist/local-marketplace
```

然后把本目录下的 `dist/local-marketplace` 作为本地插件市场添加。

## 添加账号（重要：Key 不要经过对话）

面板不能安全地接收 API Key：MCP 工具的调用参数会进入会话日志。因此 Key 的入口只有两个：

1. **终端导入（推荐，支持多账号）**：在面板「添加账号」里复制命令，到终端运行：

   ```sh
   "<node>" "<安装目录>/dist/cli.mjs" add --data-dir "<插件数据目录>"
   ```

   终端会提示输入 Key，**输入不回显**。Key 直接写入宿主加密凭据库，不经过对话、工具调用或页面。
   命令里的 node / cli / data-dir 绝对路径由面板自动填好，直接复制即可。

2. **环境变量**：启动 ZCode 前设置
   - `OPENCODE_GO_API_KEY`（第一个账号）
   - `OPENCODE_GO_API_KEY_2` … `OPENCODE_GO_API_KEY_9`（更多账号）
   - 可选 `OPENCODE_GO_LABEL` / `OPENCODE_GO_LABEL_2…9` 设置显示名

   面板里可点「从环境变量导入」把环境变量账号复制进加密凭据库。

### CLI 命令

```sh
node dist/cli.mjs --data-dir <dir> add [--label 名称]   # Key 从隐藏输入或 stdin 读取
node dist/cli.mjs --data-dir <dir> list                # 只显示指纹
node dist/cli.mjs --data-dir <dir> test [账号ID]        # 立即请求接口
node dist/cli.mjs --data-dir <dir> rename <ID> <名称>
node dist/cli.mjs --data-dir <dir> remove <ID|指纹前缀>
node dist/cli.mjs --data-dir <dir> import-env
```

## 安全模型

- **加密存储**：Windows 用 DPAPI（`CurrentUser` 作用域）加密后写入 `<数据目录>/secrets.dat`；其他平台用 AES-256-GCM，密钥文件 `secrets.key` 权限 0600。`dpapi.ps1` 通过 stdin 接收数据，Key 不出现在命令行/进程列表。
- **前端零密钥**：面板工具只返回 `sha256:<前16位>` 指纹、账号名和用量；没有任何工具、资源或错误消息返回 Key。服务端日志只写数据目录与凭据后端。
- **固定上游**：请求 URL 是常量 `https://opencode.ai/zen/go/v1/usage`，协议必须是 https、host 必须是 `opencode.ai`；不跟随重定向（`redirect: "manual"`），响应超过 256 KiB 直接拒绝。不接受用户传入 URL，因此没有 SSRF 面。
- **代理**：如果宿主进程环境设置了 `HTTPS_PROXY`/`HTTP_PROXY`，使用 undici `EnvHttpProxyAgent`；代理只来自环境变量，不接受面板输入。
- **删除即删钥**：删除账号会同时删除本地加密的 Key 元数据。
- **环境变量账号**不可在面板改名/停用/删除；它们由环境决定。

## 工具

| 工具 | 可见性 | 说明 |
|---|---|---|
| `opencode_go_usage` | model + app | 查询用量（文本 + 结构化），并可打开面板 |
| `show_usage_panel` | model + app | 对话内联打开面板 |
| `show_usage_sidebar` | model + app | 会话侧栏打开面板 |
| `get_panel_state` | app | 面板读取完整状态 |
| `refresh_usage` | app | 强制刷新全部/单账号 |
| `test_account` | app | 立即验证单个账号 |
| `rename_account` | app | 改名（本地显示名） |
| `set_account_enabled` | app | 启用/停用 |
| `remove_account` | app | 删除账号与凭据 |
| `update_settings` | app | 刷新间隔、预警阈值、语言 |
| `import_env_accounts` | app | 导入环境变量账号 |

## 数据目录

宿主通过 `ZCODE_PLUGIN_DATA` 注入，安装后通常位于：

```
~/.zcode/cli/plugins/data/opencode-go-usage@opencode-go-usage-local/
  accounts.json     # 账号元数据（无 Key）
  secrets.dat       # DPAPI/AES-GCM 加密的 Key 映射
  settings.json     # 刷新间隔、阈值、语言
  last-usage.json   # 最后一次成功快照（无 Key）
```

## 开发与测试

```sh
npm install
npm run typecheck
npm run build      # dist/server.mjs, dist/cli.mjs, dist/panel.html, dist/dpapi.ps1
npm run stage      # dist/local-marketplace（只含运行文件，不含 node_modules/测试数据）
npm run validate   # 清单、资源、MIME、安全约束、市场版本一致性
npm run smoke      # 真 MCP stdio 客户端 + 真实账号（默认读 ../../.opencode-go-usage-dev/data）
npm run mock       # mock MCP Apps 宿主，浏览器打开 http://127.0.0.1:8793/
```

`scripts/ui-test.mjs` 用 headless Chrome + CDP 跑真实面板 bundle：渲染、设置、语言切换、添加面板、改名、启停、刷新、空状态、浅色主题，并断言零 console 错误。

## 限制

- 用量接口未公开文档化，OpenCode 改结构时可能需要更新解析。
- 只适用于 **OpenCode Go 订阅**；OpenCode Zen 是预付费，没有等价的 API Key 余额接口。
- 没有底部常驻状态栏：ZCode 当前只提供 `ui.surfaces` 面板与工具内联页面。
- 自动刷新在面板打开时运行；面板关闭后没有后台轮询（插件没有常驻调度器）。
- 账号身份按 Key 的 SHA-256 指纹判断；同一 Key 不能重复添加。

## 验证记录

2026-10-20，本机实测：

- `GET https://opencode.ai/zen/go/v1/usage` 对当前 OpenCode Go 账号返回 `200`，三个窗口与 `resetsAt` 均存在。
- 真实 ZCode headless 会话调用 `opencode_go_usage`，返回 `rolling=11%, weekly=8%, monthly=90%`，证明宿主发现并加载了已安装的 MCP 服务。
- `scripts/smoke.mjs` 对源码版和安装版（`0.1.1`）服务器均通过：11 个工具、面板资源 MIME、三窗口解析、设置/改名/导入、密钥泄漏检查。
- `scripts/ui-test.mjs` 在 headless Chrome + mock MCP Apps 宿主中通过：渲染、设置保存、中英切换、添加面板、改名、启停、手动刷新、空状态、浅色主题，console 零错误。
- 扫描安装目录、插件数据目录与最近会话 rollout：未发现明文 API Key。

