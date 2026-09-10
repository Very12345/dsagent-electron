"""WebAgent's Qwen-only Rogator bootstrap.

Rogator normally restores only JWT-shaped Qwen sessions because their expiry
can be decoded locally.  Qwen Web currently also issues opaque session tokens.
WebAgent materializes those tokens only for the lifetime of the sidecar and
marks their username with ``browser:``.  This wrapper keeps that narrowly
scoped session alive without changing the pinned Rogator checkout.
"""

from __future__ import annotations

import os
import json
import runpy
import sys
import time
from pathlib import Path


source = Path(os.environ["WEBAGENT_ROGATOR_SOURCE"]).resolve()
sys.path.insert(0, str(source / "src"))
sys.path.insert(0, str(source))

from core.session.store import PlatformSession  # noqa: E402


_original_is_expired = PlatformSession.is_expired


def _webagent_is_expired(self: PlatformSession) -> bool:
    if (
        self.upstream == "qwen"
        and self.username.startswith("browser:")
        and self.is_valid
    ):
        # The file is deleted when Rogator stops.  Bound its validity anyway
        # so a crash cannot turn an opaque browser token into a durable login.
        return time.time() >= self.login_time + 24 * 60 * 60
    return _original_is_expired(self)


PlatformSession.is_expired = _webagent_is_expired

# Seed Rogator's per-account cookie binding from Electron's dedicated Qwen
# partition.  No value is logged or exposed through the local management API.
cookie_file = Path(os.environ.get("WEBAGENT_QWEN_COOKIE_FILE", ""))
try:
    browser_cookies = json.loads(cookie_file.read_text(encoding="utf-8"))
except Exception:
    browser_cookies = {}

from upstream.qwen.client import QwenClient  # noqa: E402
from upstream.qwen.chat.upload import parse as qwen_parse  # noqa: E402
from upstream.qwen.chat import session as qwen_session  # noqa: E402
from upstream.qwen.chat import sse as qwen_sse  # noqa: E402
from stream_compat import make_webagent_parser  # noqa: E402

_webagent_parse_sse_event = make_webagent_parser(qwen_parse.parse_sse_event)
qwen_parse.parse_sse_event = _webagent_parse_sse_event
# These modules import the parser by value, so update their references too.
qwen_session.parse_sse_event = _webagent_parse_sse_event
qwen_sse.parse_sse_event = _webagent_parse_sse_event

if browser_cookies:
    _original_begin_chat_cookies = QwenClient.begin_chat_cookies

    def _webagent_begin_chat_cookies(self, session, *, thinking_mode="Fast"):
        if session.username.startswith("browser:"):
            store = self._account_cookie_store(session)
            with self._cookie_jars_lock:
                store.update({str(k): str(v) for k, v in browser_cookies.items() if v not in (None, "")})
                binding = dict(store)
            if thinking_mode:
                binding["qwen-thinking_mode"] = thinking_mode
            return binding
        return _original_begin_chat_cookies(self, session, thinking_mode=thinking_mode)

    QwenClient.begin_chat_cookies = _webagent_begin_chat_cookies
runpy.run_path(str(source / "main.py"), run_name="__main__")
