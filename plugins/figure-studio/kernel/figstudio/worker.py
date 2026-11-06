"""常驻渲染进程：stdin/stdout 各一行 JSON。

为什么常驻：matplotlib 冷启动实测 0.86 s，每次拖滑块起新进程体验无法接受；
常驻后同一进程复用，渲染降到百毫秒级。

请求：
    {"id":1,"cmd":"ping"}
    {"id":2,"cmd":"inspect","script":"a.py"}
    {"id":3,"cmd":"render","script":"a.py","overrides":{...},"out":"dir"}
    {"id":4,"cmd":"plan","script":"a.py","overrides":{...}}
    {"id":5,"cmd":"apply","script":"a.py","overrides":{...},"write":true}

响应：
    {"id":2,"ok":true,"data":{...}}
    {"id":2,"ok":false,"error":{"code":"...","message":"..."}}
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import runpy
import sys
import time
import traceback

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt  # noqa: E402

from . import checks, hook, rewrite  # noqa: E402
from .atomic import atomic_write  # noqa: E402
from .paths import PathError, require_file, resolve_root, within  # noqa: E402

_MAX_LOG = 4000


class WorkerError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# ── 执行用户脚本 ────────────────────────────────────────────
def _effective_bbox(snap: dict):
    """最终生效的 bbox_inches：覆盖优先，其次脚本原值。"""
    applied = snap.get("overrides_applied") or {}
    if "savefig.bbox_inches" in applied:
        return applied["savefig.bbox_inches"]
    for r in snap.get("records", []):
        if r["scope"] == "savefig" and r["key"] == "bbox_inches":
            return r["value"]
    return None


def _run_script(script: str, overrides: dict, outdir: str | None) -> dict:
    if not os.path.isfile(script):
        raise WorkerError("not_found", f"脚本不存在：{script}")

    hook.reset(overrides, output_dir=outdir)
    buf = io.StringIO()
    t0 = time.perf_counter()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            runpy.run_path(script, run_name="__main__")
    except Exception:
        plt.close("all")
        raise WorkerError("script_failed", traceback.format_exc()[-_MAX_LOG:])
    elapsed = round((time.perf_counter() - t0) * 1000)

    snap = hook.snapshot()

    # 版面体检必须在 close 之前：量的是真实渲染框
    issues: list[dict] = []
    for fig in hook.figures():
        issues.extend(checks.check_layout(fig))
    snap["warnings"] = issues

    summary = checks.summarize(issues)
    if summary and _effective_bbox(snap) == "tight":
        summary += "（当前用 bbox_inches='tight'：这些越界会被裁掉看不见，但导出尺寸会偏）"
    snap["warning_summary"] = summary

    plt.close("all")
    snap["elapsed_ms"] = elapsed
    snap["script_stdout"] = buf.getvalue()[-_MAX_LOG:]
    if outdir and os.path.isdir(outdir):
        snap["outputs"] = sorted(
            f for f in os.listdir(outdir) if os.path.splitext(f)[1].lower() in (".png", ".pdf", ".svg")
        )
    else:
        snap["outputs"] = []
    return snap


# ── 命令分发 ────────────────────────────────────────────────
def _safe_script(req: dict) -> str:
    """请求里的脚本路径一律先过工作区校验，再交给下游。"""
    root = resolve_root(req.get("workspace"))
    return require_file(root, req.get("script") or "")


def _safe_outdir(req: dict) -> str | None:
    """输出目录只允许落在插件自己的 .preview 下，避免写到任意位置。"""
    out = req.get("out")
    if not out:
        return None
    base = os.environ.get("FIGSTUDIO_PREVIEW_ROOT")
    if base:
        return within(resolve_root(base), out)
    # 没给预览根时只接受绝对路径（由 server 生成，不是用户输入）
    if not os.path.isabs(out):
        raise WorkerError("bad_outdir", "输出目录必须是绝对路径")
    return out


def handle(req: dict) -> dict:
    cmd = req.get("cmd")
    rid = req.get("id")

    if cmd == "ping":
        return {"id": rid, "ok": True, "data": {"pong": True, "pid": os.getpid()}}

    overrides = req.get("overrides") or {}

    if cmd == "inspect":
        return {"id": rid, "ok": True, "data": _run_script(_safe_script(req), {}, None)}

    if cmd == "render":
        return {
            "id": rid,
            "ok": True,
            "data": _run_script(_safe_script(req), overrides, _safe_outdir(req)),
        }

    if cmd in ("plan", "apply"):
        script = _safe_script(req)
        with open(script, encoding="utf-8") as f:
            src = f.read()
        plan = rewrite.plan_rewrite(src, overrides)

        if cmd == "plan":
            return {
                "id": rid,
                "ok": True,
                "data": {
                    "diff": plan.diff(),
                    "applied": plan.applied,
                    "skipped": plan.skipped,
                    "edits": [e.desc for e in plan.edits],
                },
            }

        written = bool(req.get("write"))
        if written:
            backup = script + ".bak"
            if not os.path.exists(backup):
                atomic_write(backup, src)
            atomic_write(script, plan.new_source)
        return {
            "id": rid,
            "ok": True,
            "data": {
                "written": written,
                "diff": plan.diff(),
                "applied": plan.applied,
                "skipped": plan.skipped,
            },
        }

    raise WorkerError("bad_request", f"未知命令：{cmd}")


def main() -> None:
    # Windows 控制台默认 GBK，中文路径会炸
    for stream in (sys.stdin, sys.stdout):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            resp = {"id": None, "ok": False, "error": {"code": "bad_json", "message": str(e)}}
        else:
            try:
                resp = handle(req)
            except WorkerError as e:
                resp = {"id": req.get("id"), "ok": False, "error": {"code": e.code, "message": e.message}}
            except Exception:
                resp = {
                    "id": req.get("id"),
                    "ok": False,
                    "error": {"code": "internal", "message": traceback.format_exc()[-_MAX_LOG:]},
                }
        sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
