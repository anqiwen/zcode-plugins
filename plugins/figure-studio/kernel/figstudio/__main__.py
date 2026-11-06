"""命令行入口：不装插件也能用。

    python -m figstudio inspect 图12.py
    python -m figstudio render  图12.py --set axes.set_ylabel.fontsize=12.5 --out ./out
    python -m figstudio plan    图12.py --set figure.figsize=[7.2,3.6]
    python -m figstudio apply   图12.py --set figure.figsize=[7.2,3.6] --write
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile

from . import __version__, rewrite
from .atomic import atomic_write
from .paths import PathError, require_file, resolve_root
from .worker import WorkerError, _run_script


def _parse_value(raw: str):
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return raw


def _collect(pairs: list[str]) -> dict:
    out = {}
    for item in pairs or []:
        if "=" not in item:
            raise SystemExit(f"--set 需要 key=value 形式，收到：{item}")
        k, v = item.split("=", 1)
        out[k.strip()] = _parse_value(v.strip())
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="figstudio", description="调参不改源码")
    ap.add_argument("--version", action="version", version=__version__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_ins = sub.add_parser("inspect", help="跑一遍，列出所有可调参数")
    p_ins.add_argument("script")

    for name, helptext in (
        ("render", "按覆盖值重画到临时目录"),
        ("plan", "预览会怎么改源码，不落盘"),
        ("apply", "改源码"),
    ):
        p = sub.add_parser(name, help=helptext)
        p.add_argument("script")
        p.add_argument("--set", dest="sets", action="append", default=[], metavar="K=V")
        p.add_argument("--json", dest="json_file", help="从 JSON 文件读覆盖值")
        if name == "render":
            p.add_argument("--out", default=None, help="输出目录")

    p_apply = sub.choices["apply"]
    p_apply.add_argument("--write", action="store_true", help="真的写入（默认只打印 diff）")

    args = ap.parse_args(argv)

    overrides = _collect(getattr(args, "sets", []))
    if getattr(args, "json_file", None):
        with open(args.json_file, encoding="utf-8") as f:
            overrides.update(json.load(f))

    # 脚本路径一律先过校验：CLI 的工作区就是当前目录
    try:
        script = require_file(resolve_root(), args.script)
    except PathError as e:
        print(str(e), file=sys.stderr)
        print("提示：先 cd 到项目根目录再运行。", file=sys.stderr)
        return 2

    try:
        if args.cmd == "inspect":
            data = _run_script(script, {}, None)
            print(f"# {script}")
            scope = None
            for r in data["records"]:
                if r["scope"] != scope:
                    scope = r["scope"]
                    print(f"\n[{scope}]")
                print(f"  {r['key']:<24} = {r['value']!r:<26} ×{r['count']}")
            print(f"\n渲染耗时 {data['elapsed_ms']} ms；产物：{data['outputs'] or '无'}")
            return 0

        if args.cmd == "render":
            out = args.out or tempfile.mkdtemp(prefix="figstudio-")
            data = _run_script(script, overrides, out)
            print(json.dumps(
                {
                    "outputs": data["outputs"],
                    "dir": out,
                    "elapsed_ms": data["elapsed_ms"],
                    "overrides_applied": data["overrides_applied"],
                },
                ensure_ascii=False,
                indent=2,
            ))
            return 0

        with open(script, encoding="utf-8") as f:
            src = f.read()
        plan = rewrite.plan_rewrite(src, overrides)

        if args.cmd == "plan":
            print(plan.diff() or "（无改动）")
            print(f"\n已应用 {len(plan.applied)} 项：{plan.applied}")
            for k, why in plan.skipped:
                print(f"跳过 {k}：{why}")
            return 0

        # apply
        if not args.write:
            print(plan.diff() or "（无改动）")
            print(f"\n已应用 {len(plan.applied)} 项：{plan.applied}")
            for k, why in plan.skipped:
                print(f"跳过 {k}：{why}")
            print("\n（未写入。确认无误后加 --write）")
            return 0

        backup = script + ".bak"
        atomic_write(backup, src)
        atomic_write(script, plan.new_source)
        print(f"已写入 {script}（备份 {backup}）")
        print(f"应用 {len(plan.applied)} 项；跳过 {len(plan.skipped)} 项")
        return 0

    except WorkerError as e:
        print(f"[{e.code}] {e.message}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
