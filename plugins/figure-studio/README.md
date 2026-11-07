# figure-studio

**改已有 matplotlib 脚本的样式，不改它的逻辑。**

你让 Agent 画了张图，字号小了、配色土、图例位置不对——但数据、统计、布局都是对的。重画一遍代价太大。
这个插件把那张图的**样式参数**摊开给你调，调完把改动写回源码。

```
选脚本 → 读出它用了哪些样式 → 在侧栏改 → 实时看 → 写回源码（带 .bak 备份）
```

## 为什么不是"再画一张"

因为再画一张会丢东西：原来的数据筛选、统计口径、分面逻辑都在脚本里，重画意味着重新猜一遍。
figure-studio 反过来做——**脚本原样执行，只在样式赋值处拦截**。所以图的数据绝对不变。

## 两种用法

### 插件（ZCode 侧栏）

```
/show_figure_studio_sidebar   # 在侧栏打开面板
```

面板会列出工作区里的 `.py`，选一个就读参数。改任意一项 → 点「重画」→ 看效果 →「预览改动」看 diff →「写回源码」。

### 命令行（不装插件也能用）

```bash
cd kernel

# 看脚本用了哪些样式
python -m figstudio inspect ../../my_figure.py

# 按覆盖值重画（不改源码、不覆盖原成品图）
python -m figstudio render ../../my_figure.py \
    --set 'figure.figsize=[7.2,3.6]' \
    --set 'axes.set_ylabel.fontsize=11.0' \
    --out ./preview

# 预览会怎么改源码
python -m figstudio plan ../../my_figure.py --set 'axes.set_ylabel.fontsize=11.0'

# 真的写回（自动备份 .bak）
python -m figstudio apply ../../my_figure.py --set 'axes.set_ylabel.fontsize=11.0' --write
```

## 它是怎么做到的

三个动作，都在 `kernel/figstudio/`：

| 文件 | 做什么 |
|---|---|
| `hook.py` | monkey-patch `rcParams` / `Figure` / `Axes` 各方法 / `Spine` / `savefig`，**记录**脚本写的值，并按覆盖表**替换** |
| `rewrite.py` | 用 AST 定位字面量的字符偏移，**精确替换**；rcParams 走一个可整段删除的注入块 |
| `worker.py` | 常驻进程，stdin/stdout 一行 JSON。matplotlib 冷启动实测 0.86 s，每次新建进程无法接受 |

覆盖键的命名规则：

```
rc.font.size                     rcParams
figure.figsize                   Figure 构造参数
axes.set_ylabel.fontsize         调用参数（所有 set_ylabel 共用）
axes.plot#2.color                同一 Axes 上第 3 条线的颜色（按序列）
legend.loc / figure.legend.ncol  两个 legend 是不同方法，分开记
spine.linewidth                  ax.spines[...] 循环里的
ylim.range / xlim.range          坐标范围
savefig.bbox_inches              'tight' → None 才能保证导出尺寸等于声明尺寸
layout.engine: "constrained"     换自动排版，并停用 subplots_adjust
```

## 能力边界（重要）

**能改**：字号、配色、线宽、点型、图例位置/边框、图幅、DPI、坐标范围、网格、边框、导出格式与是否裁切。

**改不了，会如实报告而不是静默忽略**：

- 值是变量：`ax.set_ylim(*YLIM)`、`color=COL[cond]`
- 逐序列参数：源码里只有一个调用点（在循环里），无法按序列定位
- **结构**：图例该放哪、标题要不要省、要不要拆图——那是改图的设计，不是调参

隐藏标题/轴名是个例外：预览里 `set_visible(False)`（`plt.xlabel/title` 会委托到 Axes 方法，同样生效）；写回时在调用末尾补 `visible=False`（`ax.set_title("…", visible=False)`），原文案保留。写回只认 `ax.set_xlabel/set_ylabel/set_title(...)` 这种写法，`fig.suptitle(...)`、`ax.title.set_text(...)` 管不到，纯 `plt.title(...)` 找不到调用点时会如实跳过；多行调用补完关键字可能少一个缩进，但语法合法。

## 一个真实的坑

字号和图幅是**耦合**的，不能单独拉。实测同一张 3 面板 × 5 序列的图：

| 做法 | 结果 |
|---|---|
| 字号 9 → 12.5 pt，画布 160 mm | 崩：标题互挤、刻度糊成一片、Y 轴标签被切 |
| 同上 + `constrained_layout` | 更糟：`fig.legend(bbox_to_anchor=...)` 是绝对定位，和自动排版打架 |
| 字号 9 → 9.9 pt，画布 173 → 183 mm | 正常 |

顺带量到一个事实：**`bbox_inches='tight'` 会让导出尺寸不等于声明尺寸**——某脚本声明 172.7×86.4 mm，实际导出 180.4×88.0 mm，宽了 7.7 mm。所以这个插件默认建议关掉它，改用 `constrained_layout` + 精确 `figsize`。

正因如此，每次「重画」后都会做一次**版面体检**：用渲染器量每个文字的真实像素框，超出画布或标题互相压住的都会被列出来。用 `tight` 时体检结果会附一句提醒——这些越界会被裁掉看不见，但导出尺寸会因此偏。

实测同一张示例图：原样（9 pt、`tight`）报 1 处真溢出（X 轴名底部差 5 px）；把字号拉到 26 pt 且画布缩到 3.2 英寸时报 9 处。matplotlib 自己不会报任何错。

## 状态

`0.1.5`——内核与链路已验证，UI 可用。

- [x] 拦截 / 覆盖 / 回写三条链路，真实脚本 12/12 通过
- [x] 侧栏面板：参数列表、重画、diff 预览、写回
- [x] 常驻渲染进程（预览 38 ms/张）
- [x] 版面体检：量真实渲染框，报文字越界与标题重叠
- [x] 端到端冒烟测试 `node tests/smoke.mjs`（8 步）
- [x] `0.1.1` 参数名中文化（未登记的键回落英文原名）、脚本列表改浮层并带过滤、原图与调参结果对照
- [x] `0.1.1` 面板自测宿主 `node tests/mock-host.mjs`（真 server + 假宿主，浏览器里点完整链路）
- [x] `0.1.2` 预览改为不可变快照：token 指向独立副本，重画/对照不会改掉旧 URI；旧副本按 12 张 FIFO 清理
- [x] `0.1.2` 每个 server 进程独立预览目录（`.preview/p<pid>/`），多会话不再互相覆盖；退出清理，启动扫 24h 前的残留
- [x] `0.1.2` 解释器探测 + `error` 事件处理：Python 缺失时返回可读错误，不再崩掉 MCP server
- [x] `0.1.2` 回归测试 `node tests/preview-snapshot.mjs`（快照不变性 / 进程隔离 / 坏解释器三态）
- [x] `0.1.3` 右栏加「源码」标签：带行号与轻量 Python 高亮，读自 `read_script_source`（上限 48 KB，超出提示截断）
- [x] `0.1.3` 底部「告诉 AI」：把脚本、未写回的参数与你的原话拼成一条用户消息，`message` → `updateModelContext` → 复制降级
- [x] `0.1.3` 写回源码后自动重读参数与源码，覆盖值清零
- [x] `0.1.4` 左栏重排：参数搜索、只看已改、清空改动、默认全展开；底部固定计数条
- [x] `0.1.4` 面板状态存 `sessionStorage`（脚本 / 覆盖值 / tab），重载不丢；读参数失败清空界面不留残影
- [x] `0.1.4` 「按住看原图」闪对；忙时按钮真正禁用
- [x] `0.1.5` 「显示 / 隐藏」X 轴标题、Y 轴标题、子图标题：预览时 `set_visible(False)`，写回时给调用补 `visible=False`（保留原文案）
- [ ] 参数预设（存一套常用样式，下次一键套用）
- [ ] R / ggplot2 脚本支持

## 开发

```bash
npm install
npm run build              # 生成 dist/panel.html（把 ext-apps 打进去）
node tests/smoke.mjs             # 端到端：握手 → 扫脚本 → 读参数 → 重画 → 读预览
node tests/preview-snapshot.mjs  # 回归：预览快照不变 / 进程目录隔离 / 坏解释器不崩
node tests/mock-host.mjs         # 浏览器里看面板：http://127.0.0.1:8795/
```

Python 侧只依赖 `matplotlib` + `numpy`，不用装包。

## License

MIT
