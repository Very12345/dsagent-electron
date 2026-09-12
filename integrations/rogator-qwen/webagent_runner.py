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
import re
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
from upstream.qwen import client as qwen_client  # noqa: E402
from upstream.qwen.chat.upload import parse as qwen_parse  # noqa: E402
from upstream.qwen.chat.upload import files_upload as qwen_files_upload  # noqa: E402
from upstream.qwen.chat.upload import oss as qwen_oss  # noqa: E402
from upstream.qwen.auth.crypto import build_headers_async  # noqa: E402
from upstream.qwen.chat.upload import upstream_api as qwen_upstream_api  # noqa: E402
from upstream.qwen.chat import session as qwen_session  # noqa: E402
from upstream.qwen.chat import sse as qwen_sse  # noqa: E402
from stream_compat import make_webagent_parser  # noqa: E402

_webagent_parse_sse_event = make_webagent_parser(qwen_parse.parse_sse_event)
qwen_parse.parse_sse_event = _webagent_parse_sse_event
# These modules import the parser by value, so update their references too.
qwen_session.parse_sse_event = _webagent_parse_sse_event
qwen_sse.parse_sse_event = _webagent_parse_sse_event

# Browser-reused Qwen sessions can chat with the opaque `token` cookie, but
# Rogator's legacy upload path requested STS with generated cookies only and
# tried the retired v1 endpoint before v2. Current chat.qwen.ai responds 401,
# the upload was silently dropped, and the model received only image metadata.
# Reuse the complete browser cookie jar, prefer the current v2 endpoint, and
# make an incomplete upload fail closed instead of asking the model to pretend
# it saw an image.
if browser_cookies:
    async def _webagent_get_sts_credentials(self, session, filename, filesize, filetype):
        cookies = {}
        try:
            cookies.update(self._account_cookie_store(session))
        except Exception:
            pass
        cookies.update({str(k): str(v) for k, v in browser_cookies.items() if v not in (None, "")})
        payload = {"filename": filename, "filesize": str(filesize), "filetype": filetype}
        failures = []
        for path in ("/api/v2/files/getstsToken", "/api/v1/files/getstsToken"):
            try:
                headers = await build_headers_async(
                    session.token,
                    cookies=cookies,
                    api_path=path,
                )
                headers.update({
                    "Content-Type": "application/json;charset=UTF-8",
                    "Accept": "application/json",
                })
                creds = await self._request_sts_token(path, payload, headers)
                if creds:
                    return creds
            except Exception as exc:
                failures.append(f"{path}: {exc}")
        raise RuntimeError("Qwen browser-authenticated STS upload failed: " + "; ".join(failures))

    qwen_files_upload.UploadMixin._get_sts_credentials = _webagent_get_sts_credentials

_original_upload_base64_images = qwen_oss._upload_base64_images


async def _webagent_upload_base64_images(client, session, image_uris):
    files = await _original_upload_base64_images(client, session, image_uris)
    if image_uris and len(files) != len(image_uris):
        raise RuntimeError(
            f"Qwen image upload incomplete: expected {len(image_uris)}, uploaded {len(files)}"
        )
    return files


qwen_oss._upload_base64_images = _webagent_upload_base64_images

# WebAgent uses an internal marker to request one native Qwen webpage mode.
# Strip it before sending user text, then project the requested mode into the
# same feature_config fields used by chat.qwen.ai. Ordinary text leaves search
# off and advertises no Qwen-native tool mode; DSH-local tools remain separate.
_mode_pattern = re.compile(r'<webagent_qwen_mode\s+value="(text|search|image)"></webagent_qwen_mode>', re.I)
_image_pattern = re.compile(
    r'<webagent_qwen_image\s+model="(qwen-image-(?:2|3)\.0-pro)"\s+size="(auto|1:1|3:4|4:3|16:9|9:16)"></webagent_qwen_image>',
    re.I,
)
_original_build_qwen_message = qwen_client.build_qwen_message
_original_build_chat_payload = qwen_client.build_chat_payload


def _webagent_build_qwen_message(user_content, model, files=None, **kwargs):
    text = str(user_content or "")
    match = _mode_pattern.search(text)
    mode = match.group(1).lower() if match else "text"
    image_match = _image_pattern.search(text)
    text = _mode_pattern.sub("", text).strip()
    text = _image_pattern.sub("", text).strip()
    kwargs["auto_search"] = mode == "search"
    message = _original_build_qwen_message(text, model, files, **kwargs)
    if mode == "search":
        message["chat_type"] = "search"
        message["sub_chat_type"] = "search"
        message["extra"] = {"meta": {"subChatType": "search"}}
    elif mode == "image":
        image_model = (image_match.group(1).lower() if image_match else "qwen-image-3.0-pro")
        requested_size = image_match.group(2) if image_match else "auto"
        valid_sizes = {"1:1", "3:4", "4:3", "16:9", "9:16"}
        size = requested_size if requested_size in valid_sizes else (
            "auto" if image_model == "qwen-image-3.0-pro" else "16:9"
        )
        message["chat_type"] = "t2i"
        message["sub_chat_type"] = "t2i"
        message["feature_config"].update({
            "thinking_enabled": False,
            "auto_thinking": False,
            "thinking_mode": "Fast",
            "auto_search": False,
        })
        message["feature_config"].pop("thinking_format", None)
        message["extra"] = {
            "meta": {
                "subChatType": "t2i",
                "size": size,
                "model": image_model,
            }
        }
    return message


def _webagent_build_chat_payload(chat_id, model, qwen_message, **kwargs):
    payload = _original_build_chat_payload(chat_id, model, qwen_message, **kwargs)
    if qwen_message.get("chat_type") == "t2i":
        payload["chat_mode"] = "normal"
        payload["size"] = ((qwen_message.get("extra") or {}).get("meta") or {}).get("size", "auto")
    return payload


qwen_client.build_qwen_message = _webagent_build_qwen_message
qwen_client.build_chat_payload = _webagent_build_chat_payload

# Search and t2i are request-scoped native modes. Keep the account-level tool
# switch fully disabled so a plain text API call cannot silently execute a
# Qwen cloud tool.
for _settings in (qwen_upstream_api.DEFAULT_USER_SETTINGS_PAYLOAD,):
    _tools = _settings.setdefault("tools_enabled", {})
    _tools.update({
        "web_search": False,
        "image_gen_tool": False,
        "image_edit_tool": False,
        "code_interpreter": False,
    })

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
