"""路径校验：内核只碰工作区内的文件。

服务端（server.mjs）有自己的校验，但内核也可能被 CLI 直接调用，
所以 Python 侧必须独立把关，不能依赖上层。
"""

from __future__ import annotations

import os


class PathError(ValueError):
    """路径越界。"""


def resolve_root(explicit: str | None = None) -> str:
    """工作区根：显式参数 > 环境变量 > 当前目录。"""
    root = explicit or os.environ.get("ZCODE_WORKSPACE_ROOT") or os.getcwd()
    return os.path.realpath(root)


def within(root: str, candidate: str) -> str:
    """把 candidate 解析成绝对路径，越界就抛 PathError。

    用 realpath 而非 abspath：符号链接/junction 指到区外也要拦住。
    """
    if not candidate or "\0" in candidate:
        raise PathError("路径为空或不合法")

    root_real = os.path.realpath(root)
    target = candidate if os.path.isabs(candidate) else os.path.join(root_real, candidate)
    target_real = os.path.realpath(target)

    rel = os.path.relpath(target_real, root_real)
    if rel == ".." or rel.startswith(".." + os.sep) or os.path.isabs(rel):
        raise PathError(f"拒绝访问工作区外的路径：{candidate}")
    return target_real


def require_file(root: str, candidate: str) -> str:
    path = within(root, candidate)
    if not os.path.isfile(path):
        raise PathError(f"文件不存在：{candidate}")
    return path
