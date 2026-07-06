#!/usr/bin/env pwsh
# Convenience wrapper: run the Weft listener CLI from the repo (#156). The `weft-cli` bin lives in
# extension/bin and resolves its deps from the workspace node_modules, so it runs in-place here
# rather than from the shipped ~/.copilot/extensions/weft bundle.
#
#   .\weft-cli.ps1 start                                  # start the ephemeral listener (prints QR)
#   .\weft-cli.ps1 add-project <name> <path> [--default]  # register a spawnable project
#   .\weft-cli.ps1 list-projects
node "$PSScriptRoot\extension\bin\weft-cli.mjs" @args
exit $LASTEXITCODE
