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

  $envFile = Join-Path $root ".env"
  if (Test-Path $envFile) {
    Copy-Item $envFile (Join-Path $dest ".env") -Force
    Write-Host "Copied .env (relay credentials) next to the extension." -ForegroundColor Green
  } else {
    Write-Host "No .env at repo root. Create one next to $dest\extension.mjs with:" -ForegroundColor Yellow
    Write-Host "  WEFT_TRANSPORT=supabase" -ForegroundColor Yellow
    Write-Host "  WEFT_SUPABASE_URL=...   WEFT_SUPABASE_ANON_KEY=..." -ForegroundColor Yellow
    Write-Host "(or export those vars before 'copilot'). The extension auto-loads a colocated .env." -ForegroundColor Yellow
  }

  Write-Host "`nDone. Start 'copilot' in any repo; Weft prints a pairing QR (or run /weft). Scan it from the Weft app." -ForegroundColor Cyan
} finally {
  Pop-Location
}
