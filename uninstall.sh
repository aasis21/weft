#!/usr/bin/env bash
# Remove the installed Helm Copilot CLI extension.
set -euo pipefail
dest="$HOME/.copilot/extensions/helm"
if [ -d "$dest" ]; then
  rm -rf "$dest"
  echo "Removed $dest"
else
  echo "Nothing to remove at $dest"
fi
