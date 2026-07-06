<#
.SYNOPSIS
  One-line bootstrap installer for Helm (Windows / PowerShell).

.DESCRIPTION
  Downloads the prebuilt Helm Copilot CLI extension (+ its two standalone companion bundles:
  relayServerProcess.mjs for the shared devtunnel relay, and helm-cli.mjs — the "Device Station"
  CLI you can run on any machine, extension or no extension) and drops them where `copilot`
  auto-discovers extensions (~/.copilot/extensions/helm). Also registers a `helm-cli` command on
  your PATH. No git clone, no Node build required — just Node itself.

  Designed to be run with:
    irm https://usehelm.netlify.app/install.ps1 | iex

  With arguments (run-your-own-relay, or pick a transport up front):
    & ([scriptblock]::Create((irm https://usehelm.netlify.app/install.ps1))) -Transport devtunnel
    & ([scriptblock]::Create((irm https://usehelm.netlify.app/install.ps1))) -SupabaseUrl https://xxx.supabase.co -SupabaseKey sb_publishable_xxx

.PARAMETER InstallDir
  Where to install the extension + helm-cli. Default: ~/.copilot/extensions/helm

.PARAMETER Transport
  Your default transport: "supabase" (hosted, zero-config — the default) or "devtunnel"
  (self-hosted local relay via Microsoft Dev Tunnels, no cloud account, needs the `devtunnel` CLI).
  If omitted and the session is interactive, you'll be asked to pick.

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
    [ValidateSet('supabase', 'devtunnel', '')]
    [string]$Transport = '',
    [string]$SupabaseUrl = 'https://jqzohxjouzxzawqqlifv.supabase.co',
    [string]$SupabaseKey = 'sb_publishable_Rf_bymYhJk9fF2Op4xKT0w_eaWLiyCY',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$base = 'https://usehelm.netlify.app'

$supportsColor = $Host.UI.SupportsVirtualTerminal -or $env:WT_SESSION
function Paint($text, $code) { if ($supportsColor) { "`e[${code}m$text`e[0m" } else { $text } }
function Bold($t)   { Paint $t '1' }
function Dim($t)    { Paint $t '2' }
function Cyan($t)   { Paint $t '36' }
function Green($t)  { Paint $t '32' }
function Yellow($t) { Paint $t '33' }

function Banner($title) {
    $bar = '─' * ($title.Length + 4)
    Write-Host ''
    Write-Host (Cyan "┌$bar┐")
    Write-Host "$(Cyan '│')  $(Bold $title)  $(Cyan '│')"
    Write-Host (Cyan "└$bar┘")
}
function StepHeader($n, $total, $msg) { Write-Host "`n$(Bold "[$n/$total]") $msg" }
function Ok($msg)   { Write-Host "   $(Green '✓') $msg" }
function Info($msg) { Write-Host "   $(Dim $msg)" }
function Warn($msg) { Write-Host "   $(Yellow '!') $msg" }

$TOTAL_STEPS = 5
Banner "HELM INSTALLER"

# ---------------------------------------------------------------------------------------------
# Step 1: pick a transport (before downloading anything, so the .env we write in step 3 is right
# the first time — no separate re-run needed just to switch transports).
# ---------------------------------------------------------------------------------------------
StepHeader 1 $TOTAL_STEPS 'Choose your default transport'
if (-not $Transport) {
    $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
    if ($interactive) {
        Write-Host ''
        Write-Host "   $(Bold '1.') supabase   $(Dim '- hosted relay, zero config, works anywhere (default)')"
        Write-Host "   $(Bold '2.') devtunnel  $(Dim '- self-hosted local relay via Microsoft Dev Tunnels, no cloud account')"
        Write-Host ''
        $choice = Read-Host '   Pick 1 or 2 (Enter for 1/supabase)'
        $Transport = if ($choice.Trim() -eq '2') { 'devtunnel' } else { 'supabase' }
    } else {
        $Transport = 'supabase'
        Info 'Non-interactive session — defaulting to supabase (pass -Transport devtunnel to override).'
    }
}
Ok "Transport: $Transport"
if ($Transport -eq 'devtunnel') {
    $devtunnelOnPath = Get-Command devtunnel -ErrorAction SilentlyContinue
    if (-not $devtunnelOnPath) {
        Warn 'The `devtunnel` CLI was not found on PATH.'
        Info 'Install it with: winget install Microsoft.devtunnel'
        Info 'Then log in once with: devtunnel user login -g'
    } else {
        Info 'Found `devtunnel` on PATH — run `devtunnel user login -g` once if you have not already.'
    }
}

# ---------------------------------------------------------------------------------------------
# Step 2: download the three standalone bundles.
# ---------------------------------------------------------------------------------------------
StepHeader 2 $TOTAL_STEPS 'Downloading Helm bundles'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri "$base/extension.mjs" -OutFile (Join-Path $InstallDir 'extension.mjs') -UseBasicParsing
Ok "extension.mjs -> $InstallDir  $(Dim '(the Copilot CLI extension itself)')"
# relayServerProcess.mjs is spawned as a DETACHED sibling process by devtunnel.mjs (resolved next
# to extension.mjs at runtime) so the shared devtunnel relay/tunnel can outlive any one CLI
# session — must always be installed alongside extension.mjs, not just on first install.
Invoke-WebRequest -Uri "$base/relayServerProcess.mjs" -OutFile (Join-Path $InstallDir 'relayServerProcess.mjs') -UseBasicParsing
Ok "relayServerProcess.mjs -> $InstallDir  $(Dim '(shared devtunnel relay, only spawned if you use devtunnel)')"
# helm-cli.mjs is a fully standalone bundle (no dependency on the rest of this repo/extension) —
# it's the "Device Station" you can run on ANY machine (with or without the Copilot CLI/extension
# installed) to let your phone spawn Copilot sessions there.
Invoke-WebRequest -Uri "$base/helm-cli.mjs" -OutFile (Join-Path $InstallDir 'helm-cli.mjs') -UseBasicParsing
Ok "helm-cli.mjs -> $InstallDir  $(Dim '(standalone Device Station CLI)')"

# ---------------------------------------------------------------------------------------------
# Step 3: write / migrate the .env relay config.
# ---------------------------------------------------------------------------------------------
StepHeader 3 $TOTAL_STEPS 'Writing relay config'
$envPath = Join-Path $InstallDir '.env'
$envTemplate = @"
# Helm relay config. The publishable key is client-safe by design; the channel is
# guarded by Supabase RLS + end-to-end AES-256-GCM. To run your own relay, swap these
# for your own Supabase project's URL + publishable key.
#
# Names are Helm-namespaced on purpose: a generic SUPABASE_URL / SUPABASE_ANON_KEY
# exported globally for another Supabase project would otherwise hijack the relay.
#
# HELM_TRANSPORT picks the default: "supabase" (hosted) or "devtunnel" (self-hosted, no cloud
# account, needs the `devtunnel` CLI logged in). Change any time with:
#   helm-cli set-transport supabase --url <url> --anon-key <key>
#   helm-cli set-transport devtunnel
HELM_TRANSPORT=$Transport
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
        Ok 'kept your existing .env (use -Force to overwrite, or `helm-cli set-transport` to switch)'
    }
} else {
    $envTemplate | Set-Content -Path $envPath -Encoding utf8
    Ok "wrote relay config -> $envPath"
}

# ---------------------------------------------------------------------------------------------
# Step 4: register a `helm-cli` command on PATH (a tiny .cmd shim next to the standalone bundle).
# ---------------------------------------------------------------------------------------------
StepHeader 4 $TOTAL_STEPS 'Registering the `helm-cli` command'
$shimPath = Join-Path $InstallDir 'helm-cli.cmd'
@"
@echo off
node "%~dp0helm-cli.mjs" %*
"@ | Set-Content -Path $shimPath -Encoding ascii
Ok "helm-cli.cmd -> $InstallDir"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathEntries = @()
if ($userPath) { $pathEntries = $userPath -split ';' | Where-Object { $_ } }
if ($pathEntries -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', (($pathEntries + $InstallDir) -join ';'), 'User')
    Ok 'Added to your User PATH.'
    Warn 'Open a NEW terminal window for `helm-cli` to be found on PATH.'
} else {
    Ok 'Already on your PATH.'
}

# ---------------------------------------------------------------------------------------------
# Step 5: summary.
# ---------------------------------------------------------------------------------------------
StepHeader 5 $TOTAL_STEPS 'Done'
Write-Host ''
Write-Host "  $(Bold '1.') Start Copilot CLI in any repo (run $(Cyan '/helm') to show the QR)."
Write-Host "  $(Bold '2.') Open $(Cyan 'https://usehelm.netlify.app') on your phone and scan the QR."
Write-Host "  $(Bold '3.') Trigger a Copilot action and approve / deny from your phone."
Write-Host ''
Write-Host "  Want a station for your phone to spawn Copilot sessions on THIS machine directly"
Write-Host "  (no Copilot CLI open, just this)? Open a new terminal and run: $(Cyan 'helm-cli start')"
Write-Host ''
Write-Host (Dim "Uninstall: Remove-Item -Recurse -Force `"$InstallDir`"")
