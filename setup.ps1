#!/usr/bin/env pwsh
# Build Weft's Copilot CLI extension and install it where `copilot` auto-discovers it
# (~/.copilot/extensions/weft). Windows-first; see setup.sh for macOS/Linux.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  Write-Host "Building Weft extension..." -ForegroundColor Cyan
  npm run build -w @aasis21/weft-extension | Out-Null

  # Place the freshly-built code bundles + how-to-use skill via the CLI's own `weft install` — the
  # single cross-platform implementation of code placement (dest dirs, the three-bundle list, the
  # weft.cmd shim), shared with the cloud installer (mobile/public/install.ps1) so none of that is
  # hand-duplicated here. `--from` points it at our local build output instead of the cloud
  # release. It deliberately does NOT touch ~/.weft or PATH — those are handled below / by the
  # cloud installer. The extension folder is CODE-only; ~/.weft (config/identity/pairings) is safe.
  node (Join-Path $root "extension\dist\weft.mjs") install `
    --from (Join-Path $root "extension\dist") `
    --skill (Join-Path $root "skill\weft-how-to-use\SKILL.md")
  if ($LASTEXITCODE -ne 0) { throw "weft install failed (exit $LASTEXITCODE)" }

  # Transport is configured once, in a single file: ~/.weft/weft.config.json (via `weft
  # set-transport`) — never via .env / env vars, so re-running this script never overwrites it.
  $weftConfig = Join-Path $env:USERPROFILE ".weft\weft.config.json"
  if (Test-Path $weftConfig) {
    Write-Host "Existing transport config found at $weftConfig — left untouched." -ForegroundColor Green
  } else {
    Write-Host "No transport configured yet. Run:" -ForegroundColor Yellow
    Write-Host "  weft set-transport supabase --url <url> --anon-key <key>" -ForegroundColor Yellow
    Write-Host "(or 'weft set-transport devtunnel' for a self-hosted relay, no cloud account)." -ForegroundColor Yellow
  }

  # Remote "spawn a session" requests from the phone need a default project/folder to open. If
  # none is registered yet, ask once — leave blank to use the home directory (~). Re-running this
  # script never touches an existing default (weft.mjs's addProject only creates/updates by name).
  $weftBin = Join-Path $root "extension\bin\weft.mjs"
  $existingDefault = $null
  try {
    $existingDefault = (node $weftBin list-projects 2>$null | Select-String "\(default\)")
  } catch {
    # best-effort; treat failures as "no default yet"
  }
  if (-not $existingDefault) {
    $answer = Read-Host "Default folder for remote sessions started from the Weft app (blank = home directory, $HOME)"
    $folder = if ([string]::IsNullOrWhiteSpace($answer)) { $HOME } else { $answer }
    node $weftBin add-project home "$folder" --default
  } else {
    Write-Host "Default remote-session project already set — left untouched." -ForegroundColor Green
  }

  Write-Host "`nDone. Start 'copilot' in any repo; Weft prints a pairing QR (or run /weft). Scan it from the Weft app." -ForegroundColor Cyan
} finally {
  Pop-Location
}
