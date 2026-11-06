// 参数的中文名。
//
// 只翻译确定的东西：matplotlib 的 scope 和常见参数键。没登记的键原样显示——
// 宁可露出一串英文，也不要猜一个可能错的中文名。

const SCOPE = {
  rc: "全局样式",
  figure: "图幅",
  savefig: "导出",
  layout: "自动排版",
  "layout.engine": "排版引擎",
  subplots_adjust: "子图间距",
  tight_layout: "紧凑排版",
  legend: "图例",
  "axes.legend": "图例",
  "figure.legend": "整图图例",
  "axes.plot": "折线",
  "axes.bar": "柱状",
  "axes.barh": "条形",
  "axes.errorbar": "误差棒",
  "axes.scatter": "散点",
  "axes.fill_between": "填充带",
  "axes.step": "阶梯线",
  "axes.set_xlabel": "X 轴标题",
  "axes.set_ylabel": "Y 轴标题",
  "axes.set_title": "子图标题",
  "axes.set_xticklabels": "X 轴刻度文字",
  "axes.set_yticklabels": "Y 轴刻度文字",
  "axes.set_xticks": "X 轴刻度",
  "axes.set_yticks": "Y 轴刻度",
  "axes.tick_params": "刻度",
  "axes.grid": "网格",
  grid: "网格",
  "axes.set_xlim": "X 轴范围",
  "axes.set_ylim": "Y 轴范围",
  xlim: "X 轴范围",
  ylim: "Y 轴范围",
  "axes.set_facecolor": "绘图区底色",
  "axes.axhline": "水平参考线",
  "axes.axvline": "垂直参考线",
  "axes.annotate": "文字注记",
  "axes.text": "文字注记",
  spine: "边框",
  "axes.spines": "边框",
  spines: "边框",
  "axes.set_axisbelow": "网格层级",
};

// 带序号的作用域（axes.plot#0 …）：给个量词，读起来才像中文
const SERIES = {
  "axes.plot": "条线",
  "axes.bar": "组柱",
  "axes.barh": "组条",
  "axes.errorbar": "组误差棒",
  "axes.scatter": "组点",
  "axes.fill_between": "条填充带",
  "axes.step": "条阶梯线",
};

const KEY = {
  // 文字
  fontsize: "字号",
  size: "字号",
  labelsize: "刻度字号",
  titlesize: "标题字号",
  fontweight: "字重",
  fontfamily: "字体",
  font: "字体",
  rotation: "旋转角",
  ha: "水平对齐",
  va: "垂直对齐",
  // 颜色
  color: "颜色",
  colors: "配色",
  facecolor: "填充色",
  edgecolor: "边框色",
  markeredgecolor: "点边框色",
  markerfacecolor: "点填充色",
  ecolor: "误差棒颜色",
  // 线
  linewidth: "线宽",
  linewidths: "线宽",
  linestyle: "线型",
  marker: "点型",
  markersize: "点大小",
  markeredgewidth: "点边框宽",
  alpha: "透明度",
  zorder: "图层顺序",
  // 图例
  label: "图例名",
  loc: "位置",
  ncol: "列数",
  frameon: "显示边框",
  framealpha: "边框透明度",
  bbox_to_anchor: "锚点",
  handlelength: "图例线长",
  borderaxespad: "图例边距",
  // 图幅 / 导出
  figsize: "图幅尺寸（英寸）",
  dpi: "分辨率（dpi）",
  bbox_inches: "导出裁切",
  pad_inches: "导出留白",
  format: "导出格式",
  transparent: "透明背景",
  // 柱 / 误差棒
  width: "柱宽",
  bottom: "底部",
  capsize: "误差帽长",
  capthick: "误差帽粗",
  // 坐标 / 刻度
  axis: "作用轴",
  which: "刻度范围",
  direction: "刻度朝向",
  length: "刻度长度",
  pad: "间距",
  labelpad: "标签间距",
  range: "范围",
  autoscale: "自动缩放",
  // 间距
  left: "左边距",
  right: "右边距",
  top: "上边距",
  hspace: "行间距",
  wspace: "列间距",
  // rcParams（完整名，优先于末段匹配）
  "font.size": "基础字号",
  "font.sans-serif": "中文字体候选",
  "font.family": "字体族",
  "axes.unicode_minus": "负号正常显示",
  "axes.linewidth": "轴线宽",
  "axes.grid": "默认网格",
  "axes.titlesize": "默认标题字号",
  "axes.labelsize": "默认轴标题字号",
  "figure.figsize": "默认图幅尺寸",
  "figure.dpi": "默认分辨率",
  "savefig.dpi": "导出分辨率",
  "savefig.bbox": "导出裁切",
  "legend.fontsize": "默认图例字号",
  "legend.frameon": "默认图例边框",
  "xtick.labelsize": "X 刻度字号",
  "ytick.labelsize": "Y 刻度字号",
  "grid.linestyle": "默认网格线型",
  "grid.alpha": "默认网格透明度",
  "lines.linewidth": "默认线宽",
  "lines.markersize": "默认点大小",
  backend: "渲染后端",
  engine: "排版引擎",
};

export function labelScope(scope) {
  const m = /^(.*)#(\d+)$/.exec(scope);
  const base = m ? m[1] : scope;
  const label = SCOPE[base];
  if (!label) return scope;
  if (!m) {
    // 无序号 = 所有调用点共用；对逐序列作用域要说清楚，否则用户以为只改了一条
    return SERIES[base] ? `${label}（全部共用）` : label;
  }
  const unit = SERIES[base] || "组";
  return `${label}（第 ${Number(m[2]) + 1} ${unit}）`;
}

export function labelKey(key) {
  if (KEY[key]) return KEY[key];
  const tail = key.split(".").pop();
  return KEY[tail] || "";
}
