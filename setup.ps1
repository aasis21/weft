#!/usr/bin/env pwsh
# Build Helm's Copilot CLI extension and install it where `gh copilot` auto-discovers it
# (~/.copilot/extensions/helm). Windows-first; see setup.sh for macOS/Linux.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root
try {
  Write-Host "Building Helm extension..." -ForegroundColor Cyan
  npm run build -w @aasis21/helm-extension | Out-Null

  $bundle = Join-Path $root "extension\dist\extension.mjs"
  if (-not (Test-Path $bundle)) { throw "Build did not produce $bundle" }

  $dest = Join-Path $env:USERPROFILE ".copilot\extensions\helm"
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item $bundle (Join-Path $dest "extension.mjs") -Force
  Write-Host "Installed extension.mjs -> $dest" -ForegroundColor Green

  $envFile = Join-Path $root ".env"
  if (Test-Path $envFile) {
    Copy-Item $envFile (Join-Path $dest ".env") -Force
    Write-Host "Copied .env (relay credentials) next to the extension." -ForegroundColor Green
  } else {
    Write-Host "No .env at repo root. Create one next to $dest\extension.mjs with:" -ForegroundColor Yellow
    Write-Host "  HELM_TRANSPORT=supabase" -ForegroundColor Yellow
    Write-Host "  HELM_SUPABASE_URL=...   HELM_SUPABASE_ANON_KEY=..." -ForegroundColor Yellow
    Write-Host "(or export those vars before 'gh copilot'). The extension auto-loads a colocated .env." -ForegroundColor Yellow
  }

  Write-Host "`nDone. Start 'gh copilot' in any repo; Helm prints a pairing QR (or run /helm-pair). Scan it from the Helm app." -ForegroundColor Cyan
} finally {
  Pop-Location
}
