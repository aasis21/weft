#!/usr/bin/env pwsh
# Remove the installed Weft Copilot CLI extension.
$ErrorActionPreference = "Stop"
$dest = Join-Path $env:USERPROFILE ".copilot\extensions\weft"
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
foreach ($directory in @($desktop, $programs)) {
  $link = Join-Path $directory 'Weft Control Center.lnk'
  if (Test-Path -LiteralPath $link) {
    $shortcut = $shell.CreateShortcut($link)
    $target = Join-Path $dest 'weft.cmd'
    if ($shortcut.TargetPath -eq $env:ComSpec -and $shortcut.Arguments -eq ('/c ""' + $target + '" ui"')) {
      Remove-Item -LiteralPath $link
    }
  }
}
if (Test-Path $dest) {
  Remove-Item -Recurse -Force $dest
  Write-Host "Removed $dest" -ForegroundColor Green
} else {
  Write-Host "Nothing to remove at $dest" -ForegroundColor Yellow
}
