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

# Bundle the "how to use Weft" skill into ~/.copilot/skills/weft/ too, same as the extension
# goes into ~/.copilot/extensions/weft/ — lets the agent answer "how do I pair my phone" etc.
skill_source="$root/skill/weft/SKILL.md"
if [ -f "$skill_source" ]; then
  skill_dest="$HOME/.copilot/skills/weft"
  mkdir -p "$skill_dest"
  cp "$skill_source" "$skill_dest/SKILL.md"
  echo "Installed SKILL.md -> $skill_dest"
fi

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
