"""figure-studio 内核：不改源码，记录 / 覆盖 / 回写 matplotlib 样式参数。"""

from .hook import install, reset, snapshot
from .rewrite import plan_rewrite, rewrite_source

__version__ = "0.1.0"
__all__ = ["install", "reset", "snapshot", "plan_rewrite", "rewrite_source", "__version__"]
