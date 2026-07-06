#!/usr/bin/env bash
# Convenience wrapper: run the Weft listener CLI from the repo (#156). The `weft` bin lives in
# extension/bin and resolves its deps from the workspace node_modules, so it runs in-place here
# rather than from the shipped ~/.copilot/extensions/weft bundle.
#
#   ./weft.sh start                                  # start the ephemeral listener (prints QR)
#   ./weft.sh add-project <name> <path> [--default]  # register a spawnable project
#   ./weft.sh list-projects
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/extension/bin/weft.mjs" "$@"
