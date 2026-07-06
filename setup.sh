#!/usr/bin/env bash
# Build Weft's Copilot CLI extension and install it where `copilot` auto-discovers it
# (~/.copilot/extensions/weft). See setup.ps1 for Windows.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

echo "Building Weft extension..."
npm run build -w @aasis21/weft-extension >/dev/null

bundle="$root/extension/dist/extension.mjs"
[ -f "$bundle" ] || { echo "Build did not produce $bundle" >&2; exit 1; }

dest="$HOME/.copilot/extensions/weft"
mkdir -p "$dest"
cp "$bundle" "$dest/extension.mjs"
echo "Installed extension.mjs -> $dest"

if [ -f "$root/.env" ]; then
  cp "$root/.env" "$dest/.env"
  echo "Copied .env (relay credentials) next to the extension."
else
  echo "No .env at repo root. Create one next to $dest/extension.mjs with:"
  echo "  WEFT_TRANSPORT=supabase"
  echo "  WEFT_SUPABASE_URL=...   WEFT_SUPABASE_ANON_KEY=..."
  echo "(or export those vars before 'copilot'). The extension auto-loads a colocated .env."
fi

echo
echo "Done. Start 'copilot'; Weft prints a pairing QR (or run /weft). Scan it from the Weft app."
