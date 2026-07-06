#!/usr/bin/env bash
# Remove the installed Weft Copilot CLI extension.
set -euo pipefail
dest="$HOME/.copilot/extensions/weft"
if [ -d "$dest" ]; then
  rm -rf "$dest"
  echo "Removed $dest"
else
  echo "Nothing to remove at $dest"
fi
