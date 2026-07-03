#!/usr/bin/env pwsh
# Convenience wrapper: run the Helm listener CLI from the repo (#156). The `helm-cli` bin lives in
# extension/bin and resolves its deps from the workspace node_modules, so it runs in-place here
# rather than from the shipped ~/.copilot/extensions/helm bundle.
#
#   .\helm-cli.ps1 start                                  # start the ephemeral listener (prints QR)
#   .\helm-cli.ps1 add-project <name> <path> [--default]  # register a spawnable project
#   .\helm-cli.ps1 list-projects
node "$PSScriptRoot\extension\bin\helm-cli.mjs" @args
exit $LASTEXITCODE
