"""常驻渲染进程的启动器。

MCP server 用 `python -u run_worker.py` 拉起它，之后走 stdin/stdout 的 JSON 行协议。
单独放在这里是为了不依赖 sys.path 配置：脚本自己把 kernel 目录挂上去。
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from figstudio.worker import main  # noqa: E402

if __name__ == "__main__":
    main()
