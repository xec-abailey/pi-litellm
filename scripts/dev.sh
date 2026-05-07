#!/usr/bin/env bash
#
# pi-litellm dev mode switcher
#
# Usage:
#   ./scripts/dev.sh local   - Clone (if needed) and switch to local path
#   ./scripts/dev.sh git     - Switch back to git source
#   ./scripts/dev.sh status  - Show current mode
#
# Expects to be run from a project that has .pi/settings.json
# with pi-litellm in its packages list.

set -euo pipefail

REPO_URL="https://github.com/xec-abailey/pi-litellm.git"
LOCAL_DIR="$HOME/projects/pi-litellm"
GIT_SOURCE="git:github.com/xec-abailey/pi-litellm"

# Find the project settings file (walk up from cwd)
find_settings() {
  local dir="$PWD"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/.pi/settings.json" ]; then
      echo "$dir/.pi/settings.json"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  echo "Error: No .pi/settings.json found in current directory tree" >&2
  return 1
}

SETTINGS=$(find_settings)

# Compute relative path from settings file to LOCAL_DIR
relative_path() {
  local settings_dir
  settings_dir="$(dirname "$(cd "$(dirname "$SETTINGS")" && pwd)")"
  python3 -c "import os.path; print(os.path.relpath('$LOCAL_DIR', '$settings_dir'))"
}

case "${1:-status}" in
  local)
    # Clone if not already present
    if [ ! -d "$LOCAL_DIR" ]; then
      echo "Cloning pi-litellm to $LOCAL_DIR..."
      git clone "$REPO_URL" "$LOCAL_DIR"
    else
      echo "Local repo already exists at $LOCAL_DIR"
    fi

    REL_PATH=$(relative_path)

    # Switch settings from git to local
    if grep -q "$GIT_SOURCE" "$SETTINGS"; then
      sed -i "s|\"$GIT_SOURCE\"|\"$REL_PATH\"|" "$SETTINGS"
      echo "✓ Switched to local: $REL_PATH"
      echo "  Run /reload in Pi to pick up changes"
    elif grep -q "$REL_PATH" "$SETTINGS"; then
      echo "Already in local mode: $REL_PATH"
    else
      echo "Warning: pi-litellm not found in $SETTINGS"
      echo "  Add \"$REL_PATH\" to packages[] manually"
    fi
    ;;

  git)
    REL_PATH=$(relative_path)

    # Switch settings from local to git
    if grep -q "$REL_PATH" "$SETTINGS" 2>/dev/null || grep -q "projects/pi-litellm" "$SETTINGS"; then
      # Replace any local path variant with the git source
      sed -i -E "s|\"[^\"]*projects/pi-litellm[^\"]*\"|\"$GIT_SOURCE\"|" "$SETTINGS"
      echo "✓ Switched to git: $GIT_SOURCE"
      echo "  Run: pi update $GIT_SOURCE"
      echo "  Then /reload in Pi"
    elif grep -q "$GIT_SOURCE" "$SETTINGS"; then
      echo "Already in git mode: $GIT_SOURCE"
    else
      echo "Warning: pi-litellm not found in $SETTINGS"
    fi
    ;;

  status)
    if grep -q "projects/pi-litellm" "$SETTINGS" 2>/dev/null; then
      REL_PATH=$(relative_path)
      echo "Mode: LOCAL ($REL_PATH)"
      echo "  Edits in $LOCAL_DIR are live on /reload"
    elif grep -q "$GIT_SOURCE" "$SETTINGS"; then
      echo "Mode: GIT ($GIT_SOURCE)"
      echo "  Update with: pi update $GIT_SOURCE"
    else
      echo "Mode: UNKNOWN (pi-litellm not found in $SETTINGS)"
    fi
    ;;

  *)
    echo "Usage: $0 {local|git|status}"
    exit 1
    ;;
esac
