"""示例：一张「格式不太对」的图。

字号偏小、配色随手写、图例带框、还用了 bbox_inches='tight'——
这些正是面板要调的东西。拿它试：

    python -m figstudio inspect examples/demo.py
"""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
plt.rcParams["font.size"] = 8
plt.rcParams["axes.unicode_minus"] = False

months = [1, 2, 4, 6]
DATA = {
    "对照组": [4.92, 4.71, 4.63, 4.55],
    "PFAS组": [5.08, 5.31, 5.47, 5.22],
    "前体物组": [5.01, 5.18, 5.09, 5.38],
}
# 硬编码配色：最容易调错、也最值得调的地方
COLOR = {"对照组": "#7F8C8D", "PFAS组": "#5DADE2", "前体物组": "#F5B041"}

fig, ax = plt.subplots(figsize=(6.4, 3.2), dpi=150)
for name, ys in DATA.items():
    ax.plot(months, ys, marker="o", label=name, color=COLOR[name],
            linewidth=1.0, markersize=3)
ax.set_xlabel("实验月份", fontsize=9.0)
ax.set_ylabel("Shannon 指数", fontsize=9.0)
ax.set_title("细菌群落多样性", fontsize=9.5, fontweight="bold")
ax.legend(fontsize=7.0, loc="upper left", frameon=True)
ax.grid(axis="y", linestyle=":", alpha=0.45, color="#CCCCCC")

out = Path(__file__).with_name("demo.png")
fig.savefig(out, dpi=150, bbox_inches="tight")
print(f"wrote {out}")
