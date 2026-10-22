"""Drop-in replacement for `jieba_fast` backed by plain `jieba`.

GPT-SoVITS imports `jieba_fast`, whose C extension has no Windows wheels and needs Visual C++
Build Tools to compile. The pure-Python `jieba` exposes the same API (just slower), which is
plenty for the few sentences of a lecture page. The install scripts copy this package into the
engine's site-packages when `jieba_fast` cannot be built.
"""

from jieba import *  # noqa: F401,F403
from jieba import setLogLevel  # noqa: F401

from . import posseg  # noqa: F401
