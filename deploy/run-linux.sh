#!/usr/bin/env bash
set -euo pipefail

workspace="${WEBAGENT_WORKSPACE:-$HOME/dsh-workspace}"
display_number="${WEBAGENT_DISPLAY:-:97}"
mkdir -p "$workspace"

browser_args=()
if [ -n "${WEBAGENT_BROWSER_EXECUTABLE:-}" ]; then
  browser_args=(--browser-executable "$WEBAGENT_BROWSER_EXECUTABLE")
elif playwright_chrome="$(find "$HOME/.cache/ms-playwright" -type f -path '*/chrome-linux*/chrome' -perm -111 -print -quit 2>/dev/null)" && [ -n "$playwright_chrome" ]; then
  browser_args=(--browser-executable "$playwright_chrome")
elif command -v google-chrome >/dev/null 2>&1; then
  browser_args=(--browser-executable "$(command -v google-chrome)")
elif command -v chromium >/dev/null 2>&1; then
  browser_args=(--browser-executable "$(command -v chromium)")
elif command -v chromium-browser >/dev/null 2>&1; then
  browser_args=(--browser-executable "$(command -v chromium-browser)")
fi

if command -v Xvfb >/dev/null 2>&1; then
  Xvfb "$display_number" -screen 0 1440x900x24 -nolisten tcp -ac &
  export DISPLAY="$display_number"
  sleep 1
  if command -v openbox >/dev/null 2>&1; then openbox >/dev/null 2>&1 & fi
  if command -v x11vnc >/dev/null 2>&1; then
    x11vnc -display "$display_number" -localhost -forever -shared -nopw -rfbport 5900 >/dev/null 2>&1 &
  fi
  if command -v websockify >/dev/null 2>&1 && [ -d /usr/share/novnc ]; then
    websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
  fi
fi

exec node "$HOME/webagent-dsh-core/node_modules/webagent-dsh-core/src/node/dsh-core.js" \
  --workspace "$workspace" \
  --port "${WEBAGENT_PORT:-5858}" \
  --harness-port "${WEBAGENT_HARNESS_PORT:-3080}" \
  "${browser_args[@]}" \
  --no-open
