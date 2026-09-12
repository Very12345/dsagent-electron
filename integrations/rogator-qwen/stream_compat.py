"""Compatibility parsing for Qwen native function-role SSE events.

Rogator 2.2 treats every non-assistant delta role as a broken upstream stream
and retries through an account settings endpoint. Browser-reused Qwen sessions
cannot call that endpoint, so a valid DSH tool decision becomes `terminated`.
Keep the upstream checkout untouched and normalize only the sidecar process
started by WebAgent.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Callable, Dict, Optional


def _tool_fence(delta: Dict[str, Any]) -> str:
    candidates = delta.get("tool_calls") or (delta.get("extra") or {}).get("tool_calls") or []
    if isinstance(candidates, dict):
        candidates = [candidates]
    fences = []
    for candidate in candidates if isinstance(candidates, list) else []:
        if not isinstance(candidate, dict):
            continue
        function = candidate.get("function") if isinstance(candidate.get("function"), dict) else candidate
        name = str(function.get("name") or candidate.get("name") or "").strip()
        # Native Qwen webpage tools are executed by Qwen itself. They are
        # progress events, not Harness-local function calls, and must not be
        # serialized into the answer as dsh-tool-call fences.
        if name.lower() in {"web_search", "search", "image_gen_tool"}:
            continue
        arguments = function.get("arguments", candidate.get("arguments"))
        if not name or arguments is None:
            continue
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except (TypeError, ValueError, json.JSONDecodeError):
                # A streamed argument fragment is not safe to expose as a
                # complete DSH call. Later deltas may contain normal content.
                continue
        if not isinstance(arguments, dict):
            continue
        fences.append(
            "```dsh-tool-call\n"
            + json.dumps({"name": name, "arguments": arguments}, ensure_ascii=False, separators=(",", ":"))
            + "\n```"
        )
    function = delta.get("function_call")
    if not fences and isinstance(function, dict):
        name = str(function.get("name") or "").strip()
        if name.lower() in {"web_search", "search", "image_gen_tool"}:
            return ""
        arguments = function.get("arguments")
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except (TypeError, ValueError, json.JSONDecodeError):
                arguments = None
        if name and isinstance(arguments, dict):
            fences.append(
                "```dsh-tool-call\n"
                + json.dumps({"name": name, "arguments": arguments}, ensure_ascii=False, separators=(",", ":"))
                + "\n```"
            )
    return "\n".join(fences)


def make_webagent_parser(original: Callable[[str], Optional[Dict[str, Any]]]):
    def parse(data_str: str) -> Optional[Dict[str, Any]]:
        try:
            data = json.loads(data_str)
            choices = data.get("choices") if isinstance(data, dict) else None
            delta = choices[0].get("delta") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        except (TypeError, ValueError, json.JSONDecodeError):
            delta = None
            data = None
        if isinstance(delta, dict):
            # Qwen streams native function_call.arguments cumulatively while
            # keeping role=assistant. Emit exactly once, when the JSON becomes
            # complete; incomplete prefixes are intentionally ignored.
            fence = _tool_fence(delta)
            if fence:
                return {"type": "answer", "content": fence}
        event = original(data_str)
        if isinstance(event, dict) and event.get("type") == "image_gen_tool":
            urls = [str(url) for url in event.get("urls") or [] if str(url).startswith(("http://", "https://"))]
            if urls:
                content = "\n".join(
                    f'<webagent_qwen_image url="{url}" />\n![Qwen generated image]({url})'
                    for url in urls
                )
                return {"type": "answer", "content": content}
        if isinstance(event, dict) and event.get("type") == "image_gen":
            content = str(event.get("content") or "")
            if content:
                return {"type": "answer", "content": content}
        if isinstance(delta, dict) and delta.get("phase") == "web_search":
            info = (delta.get("extra") or {}).get("web_search_info") or []
            sources = []
            for item in info if isinstance(info, list) else []:
                if not isinstance(item, dict):
                    continue
                url = str(item.get("url") or "").strip()
                if not url.startswith(("http://", "https://")):
                    continue
                title = str(item.get("title") or url).strip().replace("[", "").replace("]", "")
                sources.append(f"[{title}]({url})")
            if sources:
                return {"type": "answer", "content": "\n".join(sources)}
        role = delta.get("role") if isinstance(delta, dict) else None
        if not role or role == "assistant":
            return event

        # Qwen also emits a role=function boundary without a call payload.
        # Remove that boundary marker and let Rogator parse any accompanying
        # answer/think content. An empty boundary is safely ignored; critically,
        # it no longer triggers Rogator's unauthorized settings retry.
        normalized = copy.deepcopy(data)
        normalized["choices"][0]["delta"].pop("role", None)
        event = original(json.dumps(normalized, ensure_ascii=False, separators=(",", ":")))
        if event is not None:
            return event
        content = delta.get("content")
        if content and delta.get("status") != "finished":
            return {"type": "answer", "content": str(content)}
        return None

    return parse


__all__ = ["make_webagent_parser"]
