<#
.SYNOPSIS
  One-line bootstrap installer for Helm (Windows / PowerShell).

.DESCRIPTION
  Downloads the prebuilt Helm Copilot CLI extension and drops it where
  `gh copilot` auto-discovers it (~/.copilot/extensions/helm), wired to the
  hosted relay so there is zero config. No git clone, no Node build.

  Designed to be run with:
    irm https://usehelm.netlify.app/install.ps1 | iex

  With arguments (run-your-own-relay):
    & ([scriptblock]::Create((irm https://usehelm.netlify.app/install.ps1))) -SupabaseUrl https://xxx.supabase.co -SupabaseKey sb_publishable_xxx

.PARAMETER InstallDir
  Where to install the extension. Default: ~/.copilot/extensions/helm

.PARAMETER SupabaseUrl
  Override the relay Supabase URL (to run your own relay).

.PARAMETER SupabaseKey
  Override the relay publishable (anon) key.

.PARAMETER Force
  Overwrite an existing .env even if one is already present.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE '.copilot\extensions\helm'),
    [string]$SupabaseUrl = 'https://jqzohxjouzxzawqqlifv.supabase.co',
    [string]$SupabaseKey = 'sb_publishable_Rf_bymYhJk9fF2Op4xKT0w_eaWLiyCY',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$base = 'https://usehelm.netlify.app'

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }

Step 'Installing Helm extension'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri "$base/extension.mjs" -OutFile (Join-Path $InstallDir 'extension.mjs') -UseBasicParsing
Ok "extension.mjs -> $InstallDir"

$envPath = Join-Path $InstallDir '.env'
$envTemplate = @"
# Helm relay config. The publishable key is client-safe by design; the channel is
# guarded by Supabase RLS + end-to-end AES-256-GCM. To run your own relay, swap these
# for your own Supabase project's URL + publishable key.
#
# Names are Helm-namespaced on purpose: a generic SUPABASE_URL / SUPABASE_ANON_KEY
# exported globally for another Supabase project would otherwise hijack the relay.
HELM_TRANSPORT=supabase
HELM_SUPABASE_URL=$SupabaseUrl
HELM_SUPABASE_ANON_KEY=$SupabaseKey
HELM_APPROVAL_TIMEOUT_MS=120000
"@

if ((Test-Path $envPath) -and -not $Force) {
    # Auto-migrate an older .env (generic SUPABASE_* only) by adding the namespaced keys,
    # preserving any custom relay values the user already set. Existing installs self-heal.
    $envText = Get-Content $envPath -Raw
    $added = @()
    if ($envText -notmatch '(?m)^\s*HELM_SUPABASE_URL=') {
        $existing = ([regex]::Match($envText, '(?m)^\s*SUPABASE_URL=(.*)$')).Groups[1].Value.Trim()
        $val = if ($existing) { $existing } else { $SupabaseUrl }
        Add-Content -Path $envPath -Value "HELM_SUPABASE_URL=$val"
        $added += 'HELM_SUPABASE_URL'
    }
    if ($envText -notmatch '(?m)^\s*HELM_SUPABASE_ANON_KEY=') {
        $existingK = ([regex]::Match($envText, '(?m)^\s*SUPABASE_ANON_KEY=(.*)$')).Groups[1].Value.Trim()
        $valK = if ($existingK) { $existingK } else { $SupabaseKey }
        Add-Content -Path $envPath -Value "HELM_SUPABASE_ANON_KEY=$valK"
        $added += 'HELM_SUPABASE_ANON_KEY'
    }
    if ($added.Count -gt 0) {
        Ok ("migrated your .env to namespaced vars (+{0})" -f ($added -join ', '))
    } else {
        Ok 'kept your existing .env (use -Force to overwrite)'
    }
} else {
    $envTemplate | Set-Content -Path $envPath -Encoding utf8
    Ok "wrote relay config -> $envPath"
}

Step 'Done'
Write-Host '  1. Start Copilot CLI in any repo (run /helm to re-show the QR).'
Write-Host '  2. Open https://usehelm.netlify.app on your phone and scan the QR.'
Write-Host '  3. Trigger a Copilot action and approve / deny from your phone.'
Write-Host ""
Write-Host "Uninstall: Remove-Item -Recurse -Force `"$InstallDir`"" -ForegroundColor DarkGray
