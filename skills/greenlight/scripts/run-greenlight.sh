#!/usr/bin/env bash
set -euo pipefail

supports_greenlight() {
  [[ -x "$1" ]] &&
    "$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 20) ? 0 : 1)' \
      >/dev/null 2>&1
}

node_bin="${GREENLIGHT_NODE_PATH:-}"
user_home="${HOME:-}"
if [[ -z "$node_bin" ]]; then
  node_bin="$(command -v node || true)"
fi

if ! supports_greenlight "$node_bin"; then
  node_bin=""
  for candidate in \
    "${NVM_BIN:-}/node" \
    "${VOLTA_HOME:-}/bin/node" \
    "$user_home"/.nvm/versions/node/*/bin/node \
    "$user_home"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$user_home"/.local/share/mise/shims/node \
    "$user_home"/.asdf/shims/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node; do
    if supports_greenlight "$candidate"; then
      node_bin="$candidate"
      break
    fi
  done
fi

if [[ -z "$node_bin" ]]; then
  echo "Greenlight: Node.js 22.20 or newer was not found. Add Node to PATH or set GREENLIGHT_NODE_PATH to its executable." >&2
  exit 1
fi

node_dir="$(cd "$(dirname "$node_bin")" && pwd -P)"
runtime_path="$node_dir"
if [[ -n "$user_home" ]]; then
  runtime_path="$runtime_path:$user_home/.local/bin:$user_home/.bun/bin"
fi
runtime_path="$runtime_path:/Applications/ChatGPT.app/Contents/Resources:/opt/homebrew/bin:/usr/local/bin"
if [[ -n "${PATH:-}" ]]; then
  runtime_path="$runtime_path:$PATH"
fi
export PATH="$runtime_path"

codex_host=0
claude_host=0
if [[ -n "${CODEX_SESSION_ID:-}${CODEX_THREAD_ID:-}${CODEX_CI:-}" ]]; then
  codex_host=1
fi
if [[ "${CLAUDECODE:-}" == "1" || -n "${CLAUDE_CODE_ENTRYPOINT:-}" ]]; then
  claude_host=1
fi

if [[ "$codex_host" == "1" && "$claude_host" == "0" ]]; then
  export GREENLIGHT_LOCAL_AGENT=codex
elif [[ "$claude_host" == "1" && "$codex_host" == "0" ]]; then
  export GREENLIGHT_LOCAL_AGENT=claude
else
  echo "Greenlight: run this skill inside a Codex or Claude Code session." >&2
  exit 1
fi

npx_bin="${GREENLIGHT_NPX_PATH:-$(command -v npx || true)}"
if [[ -z "$npx_bin" ]]; then
  echo "Greenlight: npx was not found. Install Node.js 22.20 or newer with npm." >&2
  exit 1
fi

runtime_package="${GREENLIGHT_RUNTIME_PACKAGE:-github:VC444/greenlight#main}"
exec "$npx_bin" --yes --package "$runtime_package" greenlight "$@"
