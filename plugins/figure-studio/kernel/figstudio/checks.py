"""排版体检：渲染完之后看哪些东西跑出了画布。

为什么需要它：字号和图幅是耦合的。把 9 pt 拉到 12.5 pt，而画布还是
160 mm，标题就会互挤、刻度糊成一片、Y 轴标签被切——但 matplotlib
不会报错，你只会得到一张能打开、不能用的图。

这里用渲染器量真实像素框，在导出前把问题指出来。
"""

from __future__ import annotations


def _text_of(obj) -> str:
    getter = getattr(obj, "get_text", None)
    if callable(getter):
        try:
            return str(getter())
        except Exception:
            return ""
    return ""


def check_layout(fig) -> list[dict]:
    """返回问题列表。空列表表示没发现越界或重叠。"""
    try:
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
    except Exception as exc:  # 无 GUI/渲染器不可用时不要拖垮整次渲染
        return [{"kind": "check_failed", "what": "版面检查", "text": str(exc)[:120]}]

    width, height = fig.canvas.get_width_height()
    issues: list[dict] = []
    boxes: list[tuple[str, str, object]] = []  # (kind, text, bbox)

    def collect(kind: str, obj) -> None:
        text = _text_of(obj)
        if not text.strip():
            return
        try:
            bb = obj.get_window_extent(renderer=renderer)
        except Exception:
            return
        boxes.append((kind, text, bb))
        if bb.x0 < -1 or bb.y0 < -1 or bb.x1 > width + 1 or bb.y1 > height + 1:
            issues.append(
                {
                    "kind": "overflow",
                    "what": kind,
                    "text": text[:48],
                    "bbox": [round(bb.x0), round(bb.y0), round(bb.x1), round(bb.y1)],
                    "canvas": [width, height],
                }
            )

    for ax in fig.axes:
        collect("子图标题", ax.title)
        collect("X 轴名", ax.xaxis.label)
        collect("Y 轴名", ax.yaxis.label)
        # get_xticklabels() 会带上范围外的刻度（它们不显示但存在），按坐标过滤
        x_lo, x_hi = ax.get_xlim()
        for t in ax.get_xticklabels():
            pos = t.get_position()[0]
            if x_lo - 1e-9 <= pos <= x_hi + 1e-9:
                collect("X 刻度", t)
        y_lo, y_hi = ax.get_ylim()
        for t in ax.get_yticklabels():
            pos = t.get_position()[1]
            if y_lo - 1e-9 <= pos <= y_hi + 1e-9:
                collect("Y 刻度", t)
        legend = ax.get_legend()
        if legend is not None:
            collect("图例", legend)
        # 分面/注释文字
        for t in ax.texts:
            collect("图内注释", t)

    for legend in fig.legends:
        collect("整图图例", legend)

    # 标题互相压住：多面板最常见的事故
    titles = [(text, bb) for kind, text, bb in boxes if kind == "子图标题"]
    for i in range(len(titles)):
        for j in range(i + 1, len(titles)):
            ta, ba = titles[i]
            tb, bb2 = titles[j]
            try:
                if ba.overlaps(bb2):
                    issues.append(
                        {
                            "kind": "overlap",
                            "what": "子图标题",
                            "text": f"{ta[:24]} ↔ {tb[:24]}",
                        }
                    )
            except Exception:
                continue

    return issues


def summarize(issues: list[dict]) -> str:
    if not issues:
        return ""
    overflow = sum(1 for i in issues if i.get("kind") == "overflow")
    overlap = sum(1 for i in issues if i.get("kind") == "overlap")
    parts = []
    if overflow:
        parts.append(f"{overflow} 处文字超出画布")
    if overlap:
        parts.append(f"{overlap} 处标题重叠")
    other = len(issues) - overflow - overlap
    if other:
        parts.append(f"{other} 处其他问题")
    return "；".join(parts)
