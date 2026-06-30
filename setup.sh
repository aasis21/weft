#!/usr/bin/env bash
# Build Helm's Copilot CLI extension and install it where `gh copilot` auto-discovers it
# (~/.copilot/extensions/helm). See setup.ps1 for Windows.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

echo "Building Helm extension..."
npm run build -w @aasis21/helm-extension >/dev/null

bundle="$root/extension/dist/extension.mjs"
[ -f "$bundle" ] || { echo "Build did not produce $bundle" >&2; exit 1; }

dest="$HOME/.copilot/extensions/helm"
mkdir -p "$dest"
cp "$bundle" "$dest/extension.mjs"
echo "Installed extension.mjs -> $dest"

if [ -f "$root/.env" ]; then
  cp "$root/.env" "$dest/.env"
  echo "Copied .env (relay credentials) next to the extension."
else
  echo "No .env at repo root. Create one next to $dest/extension.mjs with:"
  echo "  HELM_TRANSPORT=supabase"
  echo "  HELM_SUPABASE_URL=...   HELM_SUPABASE_ANON_KEY=..."
  echo "(or export those vars before 'gh copilot'). The extension auto-loads a colocated .env."
fi

echo
echo "Done. Start 'gh copilot'; Helm prints a pairing QR (or run /helm-pair). Scan it from the Helm app."
