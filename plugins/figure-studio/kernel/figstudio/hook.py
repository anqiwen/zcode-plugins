"""拦截 matplotlib 的样式设置：记录脚本实际用了什么，并按需覆盖。

不修改用户脚本一行代码。补丁只作用于样式参数，不碰数据与布局逻辑。

覆盖键命名：
    rc.<rcParams 键>              例：rc.font.size
    figure.<参数>                 例：figure.figsize / figure.dpi
    axes.<方法>#<序号>.<参数>     例：axes.plot#2.color（同一 Axes 上第 3 条线）
    axes.<方法>.<参数>            例：axes.plot.linewidth（所有序列共用）
    legend.<参数>                 例：legend.loc
    figure.legend.<参数>          例：figure.legend.fontsize
    ticks.<参数>                  例：ticks.labelsize
    grid.<参数>                   例：grid.alpha
    layout.<参数>                 例：layout.top
    layout.engine                 "constrained" 时切自动排版并停用 subplots_adjust
    spine.<参数>                  例：spine.linewidth
    xlim.range / ylim.range       坐标范围
    savefig.<参数>                例：savefig.dpi / savefig.bbox_inches
"""

from __future__ import annotations

import functools
import os
import sys

import numpy as np

import matplotlib
from matplotlib.axes import Axes
from matplotlib.figure import Figure
from matplotlib.spines import Spine

_MISSING = object()

_RECORDS: dict[str, dict] = {}
_OVERRIDES: dict[str, object] = {}
_FIGURES: list = []
_INSTALLED = False
_OUTPUT_DIR: str | None = None


# ── 值序列化 ────────────────────────────────────────────────
def _jsonable(v):
    if v is _MISSING or v is None:
        return None
    # np.float64 是 float 子类，必须先转，否则 json.dump 失败
    if isinstance(v, np.generic):
        return v.item()
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, np.ndarray):
        return [_jsonable(x) for x in v.tolist()]
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    return repr(v)


def _record(scope: str, key: str, value, *, count_it: bool = True) -> None:
    """记一笔。同键以最后一次为准；None 视为「脚本没设置」，不记。"""
    if value is _MISSING or value is None:
        return
    full = f"{scope}.{key}"
    entry = _RECORDS.get(full)
    if entry is None:
        _RECORDS[full] = {
            "scope": scope,
            "key": key,
            "value": _jsonable(value),
            "count": 1,
        }
    else:
        entry["value"] = _jsonable(value)
        if count_it:
            entry["count"] += 1


def _override(full: str, default=_MISSING):
    return _OVERRIDES.get(full, default)


# ── rcParams ────────────────────────────────────────────────
_RAW_RC_SETITEM = None


def _patch_rcparams() -> None:
    global _RAW_RC_SETITEM
    cls = type(matplotlib.rcParams)
    orig = cls.__setitem__
    _RAW_RC_SETITEM = orig

    def setitem(self, k, v):
        _record("rc", k, v)
        ov = _override(f"rc.{k}")
        if ov is not _MISSING:
            v = ov
        return orig(self, k, v)

    cls.__setitem__ = setitem


def _apply_rc_overrides() -> None:
    """脚本从未设置过的参数只能靠这里主动写进去。"""
    if _RAW_RC_SETITEM is None:
        return
    rc = matplotlib.rcParams
    for full, v in _OVERRIDES.items():
        if full.startswith("rc."):
            _RAW_RC_SETITEM(rc, full[3:], v)
    if "figure.figsize" in _OVERRIDES:
        _RAW_RC_SETITEM(rc, "figure.figsize", tuple(_OVERRIDES["figure.figsize"]))
    if "figure.dpi" in _OVERRIDES:
        _RAW_RC_SETITEM(rc, "figure.dpi", _OVERRIDES["figure.dpi"])


# ── Figure 创建 ─────────────────────────────────────────────
def _patch_figure() -> None:
    orig = Figure.__init__

    @functools.wraps(orig)
    def init(self, *a, **kw):
        for k in ("figsize", "dpi", "facecolor"):
            if k in kw:
                _record("figure", k, kw[k])
                ov = _override(f"figure.{k}")
                if ov is not _MISSING:
                    kw[k] = tuple(ov) if k == "figsize" else ov
        ret = orig(self, *a, **kw)
        engine = _override("layout.engine")
        if engine is not _MISSING:
            self.set_layout_engine(engine)
        _FIGURES.append(self)
        return ret

    Figure.__init__ = init


def _patch_subplots_adjust() -> None:
    """constrained 模式下手动边距会打架，直接跳过。"""
    orig = Figure.subplots_adjust

    @functools.wraps(orig)
    def wrapper(self, *a, **kw):
        for k in ("top", "bottom", "left", "right", "wspace", "hspace"):
            if k in kw:
                _record("layout", k, kw[k])
        if _override("layout.engine") is not _MISSING:
            return None
        return orig(self, *a, **kw)

    Figure.subplots_adjust = wrapper


# ── Axes 绘图方法：按序列序号记录 ────────────────────────────
_SERIES_STYLE_KEYS = (
    "color",
    "linewidth",
    "linestyle",
    "marker",
    "markersize",
    "alpha",
    "markerfacecolor",
    "markeredgecolor",
    "edgecolor",
    "linewidths",
    "s",
    "capsize",
    "capthick",
)

_PER_SERIES = {"color", "markerfacecolor", "markeredgecolor", "edgecolor", "s"}


def _patch_axes_method(name: str) -> None:
    orig = getattr(Axes, name, None)
    if orig is None:
        return

    @functools.wraps(orig)
    def wrapper(self, *a, **kw):
        attr = f"_fs_seq_{name}"
        idx = getattr(self, attr, 0)
        setattr(self, attr, idx + 1)

        for k in _SERIES_STYLE_KEYS:
            if k not in kw:
                continue
            _record(f"axes.{name}", k, kw[k])
            full = f"axes.{name}#{idx}.{k}"
            _record(f"axes.{name}#{idx}", k, kw[k], count_it=False)
            if k in _PER_SERIES:
                ov = _override(full)
            else:
                ov = _override(full, _override(f"axes.{name}.{k}"))
            if ov is not _MISSING:
                kw[k] = ov

        return orig(self, *a, **kw)

    setattr(Axes, name, wrapper)


def _patch_kwargs_method(cls, name: str, keys, scope: str) -> None:
    orig = getattr(cls, name, None)
    if orig is None:
        return

    @functools.wraps(orig)
    def wrapper(self, *a, **kw):
        for k in keys:
            if k in kw:
                _record(scope, k, kw[k])
                ov = _override(f"{scope}.{k}")
                if ov is not _MISSING:
                    kw[k] = ov
        return orig(self, *a, **kw)

    setattr(cls, name, wrapper)


# ── 坐标范围：autoscale 不算用户设置 ─────────────────────────
def _in_autoscale(depth: int = 2) -> bool:
    try:
        f = sys._getframe(depth)
    except ValueError:
        return False
    while f is not None:
        if "autoscale" in f.f_code.co_name.lower():
            return True
        f = f.f_back
    return False


def _patch_lim(name: str, scope: str) -> None:
    orig = getattr(Axes, name, None)
    getter = getattr(Axes, name.replace("set_", "get_"), None)
    if orig is None or getter is None:
        return

    @functools.wraps(orig)
    def wrapper(self, *a, **kw):
        explicit = bool(a) or bool(kw)
        ret = orig(self, *a, **kw)
        if explicit and not _in_autoscale():
            _record(scope, "range", getter(self))
            ov = _override(f"{scope}.range")
            if ov is not _MISSING:
                orig(self, *ov)
        return ret

    setattr(Axes, name, wrapper)


# ── 边框 ────────────────────────────────────────────────────
def _patch_spine() -> None:
    for method, key in (("set_linewidth", "linewidth"), ("set_color", "color")):
        orig = getattr(Spine, method, None)
        if orig is None:
            continue

        def make(orig_fn, k):
            @functools.wraps(orig_fn)
            def wrapper(self, value, *a, **kw):
                _record("spine", k, value)
                ov = _override(f"spine.{k}")
                if ov is not _MISSING:
                    value = ov
                return orig_fn(self, value, *a, **kw)

            return wrapper

        setattr(Spine, method, make(orig, key))


# ── savefig ─────────────────────────────────────────────────
def _patch_savefig() -> None:
    orig = Figure.savefig

    @functools.wraps(orig)
    def savefig(self, fname, *a, **kw):
        for k in ("dpi", "bbox_inches", "facecolor", "transparent", "pad_inches"):
            if k in kw:
                _record("savefig", k, kw[k])
                ov = _override(f"savefig.{k}")
                if ov is not _MISSING:
                    kw[k] = ov
        # 预览绝不能覆盖用户的定稿图
        if _OUTPUT_DIR:
            os.makedirs(_OUTPUT_DIR, exist_ok=True)
            fname = os.path.join(_OUTPUT_DIR, os.path.basename(str(fname)))
        return orig(self, fname, *a, **kw)

    Figure.savefig = savefig


# ── 安装 / 重置 ─────────────────────────────────────────────
def install(overrides: dict | None = None) -> None:
    global _INSTALLED
    if overrides:
        _OVERRIDES.update(overrides)
    if _INSTALLED:
        return

    _patch_rcparams()
    _patch_figure()
    _patch_subplots_adjust()
    for m in ("plot", "scatter", "bar", "barh", "errorbar", "fill_between", "step"):
        _patch_axes_method(m)

    _patch_kwargs_method(Axes, "legend", ("fontsize", "loc", "frameon", "ncol", "title"), "legend")
    _patch_kwargs_method(
        Figure, "legend",
        ("fontsize", "loc", "frameon", "ncol", "title", "bbox_to_anchor"),
        "figure.legend",
    )
    _patch_kwargs_method(Axes, "tick_params", ("labelsize", "width", "length", "colors"), "ticks")
    for m in ("set_xticklabels", "set_yticklabels"):
        _patch_kwargs_method(Axes, m, ("fontsize",), f"axes.{m}")
    for m in ("set_xlabel", "set_ylabel"):
        _patch_kwargs_method(Axes, m, ("fontsize", "labelpad", "fontweight"), f"axes.{m}")
    _patch_kwargs_method(Axes, "set_title", ("fontsize", "pad", "fontweight"), "axes.set_title")
    _patch_kwargs_method(Axes, "grid", ("alpha", "color", "linestyle", "linewidth"), "grid")

    _patch_lim("set_xlim", "xlim")
    _patch_lim("set_ylim", "ylim")
    _patch_spine()
    _patch_savefig()

    _INSTALLED = True


def reset(overrides: dict | None = None, output_dir: str | None = None) -> None:
    """每次渲染前调用：补丁就位、清记录、换覆盖值、定输出目录。"""
    global _OUTPUT_DIR
    install()
    _RECORDS.clear()
    _OVERRIDES.clear()
    _FIGURES.clear()
    _OUTPUT_DIR = output_dir
    if overrides:
        _OVERRIDES.update(overrides)
        _apply_rc_overrides()


def figures() -> list:
    """本次渲染创建过的 Figure（供版面检查用）。"""
    return list(_FIGURES)


def snapshot() -> dict:
    return {
        "records": sorted(_RECORDS.values(), key=lambda r: (r["scope"], r["key"])),
        "overrides_applied": _jsonable(_OVERRIDES),
    }
