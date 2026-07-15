#!/usr/bin/env bash
# Build Weft's Copilot CLI extension and install it where `copilot` auto-discovers it
# (~/.copilot/extensions/weft). See setup.ps1 for Windows.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

echo "Building Weft extension..."
npm run build -w @aasis21/weft-extension >/dev/null

# Place the freshly-built code bundles + how-to-use skill via the CLI's own `weft install` — the
# single cross-platform implementation of code placement (dest dirs, the three-bundle list, the
# shim), shared with the cloud installer (mobile/public/install.sh) so none of that is
# hand-duplicated here. --from points it at our local build output instead of the cloud release.
# It deliberately does NOT touch ~/.weft or PATH — those are handled below / by the cloud installer.
node "$root/extension/dist/weft.mjs" install \
  --from "$root/extension/dist" \
  --skill "$root/skill/weft-how-to-use/SKILL.md"

# Transport is configured once, in a single file: ~/.weft/weft.config.json (via `weft
# set-transport`) — never via .env / env vars, so re-running this script never overwrites it.
weft_config="$HOME/.weft/weft.config.json"
if [ -f "$weft_config" ]; then
  echo "Existing transport config found at $weft_config — left untouched."
else
  echo "No transport configured yet. Run:"
  echo "  weft set-transport supabase --url <url> --anon-key <key>"
  echo "(or 'weft set-transport devtunnel' for a self-hosted relay, no cloud account)."
fi

# Remote "spawn a session" requests from the phone need a default project/folder to open. If
# none is registered yet, ask once — leave blank to use the home directory (~). Re-running this
# script never touches an existing default (weft.mjs's addProject only creates/updates by name).
weft_bin="$root/extension/bin/weft.mjs"
if node "$weft_bin" list-projects 2>/dev/null | grep -q "(default)"; then
  echo "Default remote-session project already set — left untouched."
else
  read -r -p "Default folder for remote sessions started from the Weft app (blank = home directory, $HOME): " folder
  folder="${folder:-$HOME}"
  node "$weft_bin" add-project home "$folder" --default
fi

echo
echo "Done. Start 'copilot'; Weft prints a pairing QR (or run /weft). Scan it from the Weft app."
