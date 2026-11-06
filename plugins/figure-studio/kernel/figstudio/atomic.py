"""原子写入：先写同目录临时文件，再 os.replace 替换。

两个好处：
  1) 写一半崩溃不会把用户脚本截断成半截
  2) 句柄落在 mkstemp 生成的临时文件上，不是拼出来的路径
"""

from __future__ import annotations

import os
import tempfile


def atomic_write(target: str, text: str) -> None:
    directory = os.path.dirname(os.path.abspath(target)) or "."
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".figstudio-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.replace(tmp, target)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
