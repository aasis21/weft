#!/usr/bin/env pwsh
# Remove the installed Helm Copilot CLI extension.
$ErrorActionPreference = "Stop"
$dest = Join-Path $env:USERPROFILE ".copilot\extensions\helm"
if (Test-Path $dest) {
  Remove-Item -Recurse -Force $dest
  Write-Host "Removed $dest" -ForegroundColor Green
} else {
  Write-Host "Nothing to remove at $dest" -ForegroundColor Yellow
}
