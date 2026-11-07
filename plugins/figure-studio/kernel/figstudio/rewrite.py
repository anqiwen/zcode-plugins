"""把调好的参数写回源码。

两条路线：
  1) rcParams 类      → 在 import 区之后插入「调参覆盖」块，可整段删除恢复原样
  2) 调用参数字面量   → AST 定位值节点，按字符偏移精确替换，不动其他任何字节

改不了的情况会如实报告，不静默忽略：
  · 值是变量而非字面量，例如 ylim 用 `*YLIM`、颜色用 `COL[cond]`
  · 逐序列参数（键带 #n），源码里只有一个调用点，无法按序列定位
"""

from __future__ import annotations

import ast
import difflib
from dataclasses import dataclass, field

FS_BLOCK_START = "# >>> figure-studio 调参覆盖（自动生成，可整段删除）"
FS_BLOCK_END = "# <<< figure-studio"


@dataclass
class Edit:
    start: int
    end: int
    new_text: str
    desc: str


@dataclass
class Plan:
    source: str
    new_source: str
    edits: list[Edit] = field(default_factory=list)
    applied: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)

    def diff(self) -> str:
        return "".join(
            difflib.unified_diff(
                self.source.splitlines(keepends=True),
                self.new_source.splitlines(keepends=True),
                fromfile="原脚本",
                tofile="调参后",
                n=2,
            )
        )


# ── 位置换算 ────────────────────────────────────────────────
def _line_starts(source: str) -> list[int]:
    starts = [0]
    for i, ch in enumerate(source):
        if ch == "\n":
            starts.append(i + 1)
    return starts


def _offset(starts: list[int], lines: list[str], lineno: int, col: int) -> int:
    """ast 的 col_offset 是 UTF-8 字节偏移，含中文的行必须换算成字符偏移。"""
    line = lines[lineno - 1]
    prefix = line.encode("utf-8")[:col].decode("utf-8", errors="ignore")
    return starts[lineno - 1] + len(prefix)


# ── 值渲染 ──────────────────────────────────────────────────
def render_value(v) -> str:
    if isinstance(v, bool):
        return "True" if v else "False"
    if v is None:
        return "None"
    if isinstance(v, (int, float)):
        return repr(v)
    if isinstance(v, str):
        return repr(v)
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(render_value(x) for x in v) + "]"
    return repr(v)


# ── AST 辅助 ────────────────────────────────────────────────
def _call_attr(node: ast.Call) -> str | None:
    f = node.func
    if isinstance(f, ast.Attribute):
        return f.attr
    if isinstance(f, ast.Name):
        return f.id
    return None


def _receiver_name(node: ast.Call) -> str:
    f = node.func
    if isinstance(f, ast.Attribute) and isinstance(f.value, ast.Name):
        return f.value.id
    return ""


def _is_figure_legend(recv: str) -> bool:
    low = recv.lower()
    return "fig" in low and "ax" not in low


def _is_literal(node: ast.AST) -> bool:
    """能否当字面量直接替换：常量、元组/列表、负数。"""
    if isinstance(node, ast.Constant):
        return True
    if isinstance(node, (ast.Tuple, ast.List)):
        return all(_is_literal(e) for e in node.elts)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return _is_literal(node.operand)
    return False


# ── 注入块 ──────────────────────────────────────────────────
def _import_insert_offset(tree: ast.Module, starts: list[int], lines: list[str]) -> int:
    last_end = 0
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            last_end = node.end_lineno
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            break
    if last_end == 0:
        if tree.body and isinstance(tree.body[0], ast.Expr):
            last_end = tree.body[0].end_lineno
        else:
            return 0
    return starts[last_end] if last_end < len(starts) else len("".join(lines))


def build_rc_block(rc_overrides: dict) -> str:
    body = "\n".join(
        f"    {k!r}: {render_value(v)}," for k, v in sorted(rc_overrides.items())
    )
    return (
        f"{FS_BLOCK_START}\n"
        f"# 这一段压过脚本里所有的 rcParams 设置；改它就等于改整套样式。\n"
        f"import matplotlib as _fs_mpl\n"
        f"_fs_mpl.rcParams.update({{\n{body}\n}})\n"
        f"{FS_BLOCK_END}\n"
    )


def _strip_existing_block(source: str) -> str:
    out, skip = [], False
    for line in source.splitlines(keepends=True):
        if line.strip() == FS_BLOCK_START:
            skip = True
            continue
        if line.strip() == FS_BLOCK_END:
            skip = False
            continue
        if not skip:
            out.append(line)
    return "".join(out)


# ── 覆盖键 → 源码调用形式 ───────────────────────────────────
# 隐藏标题/轴名：不是改某个参数，而是在调用末尾补 visible=False（保留原文案）
HIDE_TARGETS = {
    "axes.set_xlabel.hide": "set_xlabel",
    "axes.set_ylabel.hide": "set_ylabel",
    "axes.set_title.hide": "set_title",
}


def _call_close_offset(node, starts, lines, source: str):
    """Call 节点右括号的字符偏移；对不上就返回 None。"""
    end = _offset(starts, lines, node.end_lineno, node.end_col_offset)
    i = end - 1
    while i >= 0 and source[i] in " \t\r\n":
        i -= 1
    if i < 0 or source[i] != ")":
        return None
    return i


def _prev_nonspace(source: str, pos: int) -> str:
    i = pos - 1
    while i >= 0 and source[i] in " \t\r\n":
        i -= 1
    return source[i] if i >= 0 else ""


def _resolve_target(full: str):
    """返回 (方法名 或 方法名元组, 关键字名, 接收者提示)。关键字名为 None 表示位置参数。"""
    if full.startswith("figure.legend."):
        return "legend", full.rsplit(".", 1)[1], "figure"
    parts = full.split(".")
    head = parts[0]
    if head == "axes":
        return parts[1], parts[-1], None
    if head == "figure":
        return ("subplots", "figure"), parts[-1], None
    if head == "legend":
        return "legend", parts[-1], "axes"
    if head == "ticks":
        return "tick_params", parts[-1], None
    if head == "grid":
        return "grid", parts[-1], None
    if head == "layout":
        return "subplots_adjust", parts[-1], None
    if head == "savefig":
        return "savefig", parts[-1], None
    if head == "spine":
        return f"set_{parts[-1]}", None, None
    if head in ("xlim", "ylim"):
        return f"set_{head}", None, None
    return None, None, None


# ── 主流程 ──────────────────────────────────────────────────
def plan_rewrite(source: str, overrides: dict) -> Plan:
    applied: list[str] = []
    skipped: list[tuple[str, str]] = []

    rc_ov = {k[3:]: v for k, v in overrides.items() if k.startswith("rc.")}
    call_ov = {k: v for k, v in overrides.items() if not k.startswith("rc.")}

    # 排版引擎不是调用参数，落成 rcParam；同时要停用脚本里的手动边距
    engine = call_ov.pop("layout.engine", None)
    applied_engine = None
    if engine:
        rc_ov["figure.constrained_layout.use"] = engine == "constrained"
        applied_engine = engine

    base = _strip_existing_block(source)
    tree = ast.parse(base)
    lines = base.splitlines(keepends=True)
    starts = _line_starts(base)

    # ── 1) 字面量替换 ──
    edits: list[Edit] = []
    for full, new_val in call_ov.items():
        if "#" in full:
            skipped.append((full, "逐序列参数：源码里只有一个调用点，无法按序列定位"))
            continue
        if full in HIDE_TARGETS:
            method = HIDE_TARGETS[full]
            if not bool(new_val):
                skipped.append((full, "hide=false 不需要写回（默认就是显示）"))
                continue
            hit = 0
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call) or _call_attr(node) != method:
                    continue
                if any(kw.arg == "visible" for kw in node.keywords):
                    skipped.append((full, "调用点已经有 visible=，不覆盖"))
                    continue
                pos = _call_close_offset(node, starts, lines, base)
                if pos is None:
                    continue
                ins = "visible=False" if _prev_nonspace(base, pos) == "," else ", visible=False"
                edits.append(Edit(pos, pos, ins, f"{method}(…) 末尾补 visible=False"))
                hit += 1
            if hit:
                applied.append(full)
            else:
                skipped.append((full, f"源码里没有找到 {method}(...) 调用点"))
            continue
        method, kwarg, hint = _resolve_target(full)
        if method is None:
            skipped.append((full, "无法映射到源码调用"))
            continue

        hit = 0
        methods = (method,) if isinstance(method, str) else method
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or _call_attr(node) not in methods:
                continue
            if hint is not None:
                is_fig = _is_figure_legend(_receiver_name(node))
                if hint == "figure" and not is_fig:
                    continue
                if hint == "axes" and is_fig:
                    continue

            if kwarg is None:
                # 位置参数：set_ylim(4.5, 7.6) / set_linewidth(0.8)
                if not node.args:
                    continue
                if not all(_is_literal(a) for a in node.args):
                    skipped.append((full, "位置参数含变量，非字面量"))
                    continue
                vals = list(new_val) if isinstance(new_val, (list, tuple)) else [new_val]
                if len(vals) != len(node.args):
                    skipped.append(
                        (full, f"新值 {len(vals)} 个但调用点有 {len(node.args)} 个位置参数")
                    )
                    continue
                s = _offset(starts, lines, node.args[0].lineno, node.args[0].col_offset)
                last = node.args[-1]
                e = _offset(starts, lines, last.end_lineno, last.end_col_offset)
                txt = ", ".join(render_value(x) for x in vals)
                old = ", ".join(ast.unparse(a) for a in node.args)
                edits.append(Edit(s, e, txt, f"{method}({old}) → ({txt})"))
                hit += 1
                continue

            for kw in node.keywords:
                if kw.arg != kwarg:
                    continue
                if not _is_literal(kw.value):
                    skipped.append(
                        (full, f"值是变量（{ast.unparse(kw.value)}），不是字面量")
                    )
                    continue
                s = _offset(starts, lines, kw.value.lineno, kw.value.col_offset)
                e = _offset(starts, lines, kw.value.end_lineno, kw.value.end_col_offset)
                edits.append(
                    Edit(
                        s,
                        e,
                        render_value(new_val),
                        f"{method}({kwarg}={ast.unparse(kw.value)}) → {render_value(new_val)}",
                    )
                )
                hit += 1
        if hit:
            applied.append(full)

    # ── 2) constrained 与手动边距冲突：整句注释掉（可逆、可审计）──
    if applied_engine == "constrained":
        for node in ast.walk(tree):
            if not isinstance(node, ast.Expr):
                continue
            call = node.value
            if not isinstance(call, ast.Call) or _call_attr(call) != "subplots_adjust":
                continue
            for ln in range(node.lineno, node.end_lineno + 1):
                pos = starts[ln - 1]
                edits.append(
                    Edit(pos, pos, "# ", f"停用手动边距（改用 constrained layout）：第 {ln} 行")
                )
            applied.append("layout.engine")

    # ── 3) rcParams 注入块 ──
    if rc_ov:
        pos = _import_insert_offset(tree, starts, lines)
        edits.append(
            Edit(pos, pos, "\n" + build_rc_block(rc_ov), f"注入 rcParams 覆盖（{len(rc_ov)} 项）")
        )
        applied.extend(f"rc.{k}" for k in rc_ov)

    # ── 4) 从后往前应用，避免偏移错位 ──
    new = base
    for ed in sorted(edits, key=lambda x: x.start, reverse=True):
        new = new[: ed.start] + ed.new_text + new[ed.end :]

    seen: set[tuple[str, str]] = set()
    uniq: list[tuple[str, str]] = []
    for k, why in skipped:
        if (k, why) in seen:
            continue
        seen.add((k, why))
        uniq.append((k, why))

    return Plan(source=source, new_source=new, edits=edits, applied=applied, skipped=uniq)


def rewrite_source(source: str, overrides: dict) -> str:
    return plan_rewrite(source, overrides).new_source
