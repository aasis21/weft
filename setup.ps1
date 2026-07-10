#!/usr/bin/env pwsh
# Build Weft's Copilot CLI extension and install it where `copilot` auto-discovers it
# (~/.copilot/extensions/weft). Windows-first; see setup.sh for macOS/Linux.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  Write-Host "Building Weft extension..." -ForegroundColor Cyan
  npm run build -w @aasis21/weft-extension | Out-Null

  $bundle = Join-Path $root "extension\dist\extension.mjs"
  if (-not (Test-Path $bundle)) { throw "Build did not produce $bundle" }

  $dest = Join-Path $env:USERPROFILE ".copilot\extensions\weft"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item $bundle (Join-Path $dest "extension.mjs") -Force
  Write-Host "Installed extension.mjs -> $dest" -ForegroundColor Green

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

  Write-Host "`nDone. Start 'copilot' in any repo; Weft prints a pairing QR (or run /weft). Scan it from the Weft app." -ForegroundColor Cyan
} finally {
  Pop-Location
}
