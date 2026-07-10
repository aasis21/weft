<#
.SYNOPSIS
  One-line bootstrap installer for Weft (Windows / PowerShell).

.DESCRIPTION
  Downloads the prebuilt Weft Copilot CLI extension (+ its two standalone companion bundles:
  relayServerProcess.mjs for the shared devtunnel relay, and weft.mjs — the "Device Station"
  CLI you can run on any machine, extension or no extension) and drops them where `copilot`
  auto-discovers extensions (~/.copilot/extensions/weft — CODE only). Also installs a
  "how to use Weft" skill to ~/.copilot/skills/weft-how-to-use/SKILL.md, the same way the extension goes
  to ~/.copilot/extensions/weft, so the agent can answer usage questions directly. All user
  config (projects, transport choice) lives separately in ~/.weft/weft.config.json, written via
  `weft set-transport` — there is NO env var / .env for this, so re-running this installer to
  update to a newer build never silently resets or shadows your chosen transport. Also
  registers a `weft` command on your PATH. No git clone, no Node build required — just Node
  itself.

  Designed to be run with:
    irm https://useweft.netlify.app/install.ps1 | iex

  With arguments (run-your-own-relay, or pick a transport up front):
    & ([scriptblock]::Create((irm https://useweft.netlify.app/install.ps1))) -Transport devtunnel
    & ([scriptblock]::Create((irm https://useweft.netlify.app/install.ps1))) -SupabaseUrl https://xxx.supabase.co -SupabaseKey sb_publishable_xxx

.PARAMETER InstallDir
  Where to install the extension + weft. Default: ~/.copilot/extensions/weft

.PARAMETER Transport
  Your default transport: "supabase" (hosted, zero-config — the default) or "devtunnel"
  (self-hosted local relay via Microsoft Dev Tunnels, no cloud account, needs the `devtunnel` CLI).
  If omitted: an existing ~/.weft/weft.config.json choice is left untouched (this installer only
  ever refreshes code, never your config); otherwise, if the session is interactive, you'll be
  asked to pick, or it defaults to supabase non-interactively.

.PARAMETER SupabaseUrl
  Override the relay Supabase URL (to run your own relay).

.PARAMETER SupabaseKey
  Override the relay publishable (anon) key.

.PARAMETER DeviceName
  The name shown to your phone for this machine (DEVICES list in the app). If omitted: an
  existing ~/.weft/weft.config.json choice is left untouched; otherwise, if the session is
  interactive, you'll be prompted with your hostname as the default (just press Enter to keep
  it), or it defaults to the hostname non-interactively without writing anything (so it keeps
  following hostname changes until you explicitly set your own with `weft set-name`).

.PARAMETER Force
  Re-apply -Transport (or the default) even if a transport is already configured in
  ~/.weft/weft.config.json, overwriting it. Also re-applies -DeviceName (or re-prompts for one)
  even if a device name is already configured.
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:USERPROFILE '.copilot\extensions\weft'),
    [ValidateSet('supabase', 'devtunnel', '')]
    [string]$Transport = '',
    [string]$SupabaseUrl = 'https://jqzohxjouzxzawqqlifv.supabase.co',
    [string]$SupabaseKey = 'sb_publishable_Rf_bymYhJk9fF2Op4xKT0w_eaWLiyCY',
    [string]$DeviceName = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$base = 'https://useweft.netlify.app'

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

$TOTAL_STEPS = 6
Banner "WEFT INSTALLER"

# ---------------------------------------------------------------------------------------------
# Step 1: pick a transport. An existing ~/.weft/weft.config.json choice always wins unless the
# caller explicitly passed -Transport or -Force — this installer only ever refreshes CODE under
# $InstallDir, never the user's config, so a plain re-run/upgrade can't silently reset it.
# ---------------------------------------------------------------------------------------------
StepHeader 1 $TOTAL_STEPS 'Choose your default transport'
$transportExplicit = $PSBoundParameters.ContainsKey('Transport') -and $Transport -ne ''
$weftHome = Join-Path $env:USERPROFILE '.weft'
$weftConfigPath = Join-Path $weftHome 'weft.config.json'
$existingTransportKind = $null
if (Test-Path $weftConfigPath) {
    try {
        $cfg = Get-Content $weftConfigPath -Raw | ConvertFrom-Json
        if ($cfg.transport -and $cfg.transport.kind -in @('supabase', 'devtunnel')) {
            $existingTransportKind = $cfg.transport.kind
        }
    } catch {
        # Unreadable/invalid — treat as unset, same as the extension's own loader does.
    }
}

$applyTransport = $true
$legacyEnvPaths = @((Join-Path $InstallDir '.env'), (Join-Path $weftHome '.env'))
if ($existingTransportKind -and -not $transportExplicit -and -not $Force) {
    $Transport = $existingTransportKind
    $applyTransport = $false
    Ok "Existing transport config found ($Transport) -> $weftConfigPath — left untouched."
    Info 'Pass -Transport <name> or -Force to change it.'
} else {
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
}
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
StepHeader 2 $TOTAL_STEPS 'Downloading Weft bundles'
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Invoke-WebRequest -Uri "$base/extension.mjs" -OutFile (Join-Path $InstallDir 'extension.mjs') -UseBasicParsing
Ok "extension.mjs -> $InstallDir  $(Dim '(the Copilot CLI extension itself)')"
# relayServerProcess.mjs is spawned as a DETACHED sibling process by devtunnel.mjs (resolved next
# to extension.mjs at runtime) so the shared devtunnel relay/tunnel can outlive any one CLI
# session — must always be installed alongside extension.mjs, not just on first install.
Invoke-WebRequest -Uri "$base/relayServerProcess.mjs" -OutFile (Join-Path $InstallDir 'relayServerProcess.mjs') -UseBasicParsing
Ok "relayServerProcess.mjs -> $InstallDir  $(Dim '(shared devtunnel relay, only spawned if you use devtunnel)')"
# weft.mjs is a fully standalone bundle (no dependency on the rest of this repo/extension) —
# it's the "Device Station" you can run on ANY machine (with or without the Copilot CLI/extension
# installed) to let your phone spawn Copilot sessions there.
Invoke-WebRequest -Uri "$base/weft.mjs" -OutFile (Join-Path $InstallDir 'weft.mjs') -UseBasicParsing
Ok "weft.mjs -> $InstallDir  $(Dim '(standalone Device Station CLI)')"
# The "how to use Weft" skill goes to ~/.copilot/skills/weft-how-to-use/SKILL.md — same convention as the
# extension going to ~/.copilot/extensions/weft — so the agent can answer "how do I pair my
# phone" / "how do I switch transport" etc. without the user having to ask us directly.
$skillDir = Join-Path $env:USERPROFILE '.copilot\skills\weft-how-to-use'
New-Item -ItemType Directory -Force -Path $skillDir | Out-Null
Invoke-WebRequest -Uri "$base/weft-skill.md" -OutFile (Join-Path $skillDir 'SKILL.md') -UseBasicParsing
Ok "SKILL.md -> $skillDir  $(Dim '(how-to-use skill for the Copilot CLI agent)')"

# ---------------------------------------------------------------------------------------------
# Step 3: apply the transport choice to ~/.weft/weft.config.json — the ONLY place the extension
# and weft.mjs ever read transport config from (no env var, no .env — see transportConfig.mjs /
# transportFactory.mjs). Calls the just-downloaded weft.mjs's own `set-transport` command so this
# installer never has to duplicate its validation/persistence logic. A stale .env from an older
# install (that config format is retired, no migration) is simply removed so it can't linger
# around looking authoritative when it's now inert.
# ---------------------------------------------------------------------------------------------
StepHeader 3 $TOTAL_STEPS 'Applying transport config'
New-Item -ItemType Directory -Force -Path $weftHome | Out-Null
$weftBin = Join-Path $InstallDir 'weft.mjs'

foreach ($p in $legacyEnvPaths) {
    if (Test-Path $p) {
        Remove-Item -Path $p -Force
        Ok "removed stale $p  $(Dim '(config now lives only in weft.config.json)')"
    }
}

if ($applyTransport) {
    if ($Transport -eq 'supabase') {
        & node $weftBin set-transport supabase --url $SupabaseUrl --anon-key $SupabaseKey | Out-Null
    } else {
        & node $weftBin set-transport devtunnel | Out-Null
    }
    if ($LASTEXITCODE -ne 0) { throw "weft set-transport failed (exit $LASTEXITCODE)" }
    Ok "wrote transport config ($Transport) -> $weftConfigPath"
}

# ---------------------------------------------------------------------------------------------
# Step 4: choose a device name — shown to your phone in the DEVICES list instead of the raw OS
# hostname. An existing ~/.weft/weft.config.json choice always wins unless the caller explicitly
# passed -DeviceName or -Force (same "installer only ever refreshes code" contract as Step 1's
# transport choice). Calls the just-downloaded weft.mjs's own `set-name` command so this installer
# never has to duplicate its validation/persistence logic.
# ---------------------------------------------------------------------------------------------
StepHeader 4 $TOTAL_STEPS 'Choose your device name'
$deviceNameExplicit = $PSBoundParameters.ContainsKey('DeviceName') -and $DeviceName -ne ''
$existingDeviceName = $null
if (Test-Path $weftConfigPath) {
    try {
        $cfg = Get-Content $weftConfigPath -Raw | ConvertFrom-Json
        if ($cfg.deviceName) { $existingDeviceName = $cfg.deviceName }
    } catch {
        # Unreadable/invalid — treat as unset, same as the extension's own loader does.
    }
}

if ($existingDeviceName -and -not $deviceNameExplicit -and -not $Force) {
    Ok "Existing device name found ($existingDeviceName) -> $weftConfigPath — left untouched."
    Info 'Pass -DeviceName <name> or -Force to change it.'
} else {
    $defaultDeviceName = if ($DeviceName) { $DeviceName } else { $env:COMPUTERNAME }
    $chosenDeviceName = $defaultDeviceName
    if (-not $deviceNameExplicit) {
        $interactive = [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
        if ($interactive) {
            Write-Host ''
            $typed = Read-Host "   Device name shown to your phone (Enter for '$defaultDeviceName')"
            if ($typed.Trim()) { $chosenDeviceName = $typed.Trim() }
        } else {
            Info "Non-interactive session — using hostname '$defaultDeviceName' (pass -DeviceName to override)."
        }
    }
    & node $weftBin set-name $chosenDeviceName | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "weft set-name failed (exit $LASTEXITCODE)" }
    Ok "Device name: $chosenDeviceName -> $weftConfigPath"
}

# ---------------------------------------------------------------------------------------------
# Step 5: register a `weft` command on PATH (a tiny .cmd shim next to the standalone bundle).
# ---------------------------------------------------------------------------------------------
StepHeader 5 $TOTAL_STEPS 'Registering the `weft` command'
$shimPath = Join-Path $InstallDir 'weft.cmd'
@"
@echo off
node "%~dp0weft.mjs" %*
"@ | Set-Content -Path $shimPath -Encoding ascii
Ok "weft.cmd -> $InstallDir"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathEntries = @()
if ($userPath) { $pathEntries = $userPath -split ';' | Where-Object { $_ } }
if ($pathEntries -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', (($pathEntries + $InstallDir) -join ';'), 'User')
    Ok 'Added to your User PATH.'
    Warn 'Open a NEW terminal window for `weft` to be found on PATH.'
} else {
    Ok 'Already on your PATH.'
}

# ---------------------------------------------------------------------------------------------
# Step 6: summary.
# ---------------------------------------------------------------------------------------------
StepHeader 6 $TOTAL_STEPS 'Done'
Write-Host ''
Write-Host "  $(Bold '1.') Start Copilot CLI in any repo (run $(Cyan '/weft') to show the QR)."
Write-Host "  $(Bold '2.') Open $(Cyan 'https://useweft.netlify.app') on your phone and scan the QR."
Write-Host "  $(Bold '3.') Trigger a Copilot action and approve / deny from your phone."
Write-Host ''
Write-Host "  Want a station for your phone to spawn Copilot sessions on THIS machine directly"
Write-Host "  (no Copilot CLI open, just this)? Open a new terminal and run: $(Cyan 'weft start')"
Write-Host ''
if ($Transport -eq 'devtunnel') {
    Write-Host "  Using devtunnel: provision/check/tear down the shared relay any time, independent"
    Write-Host "  of any pairing session, with: $(Cyan 'weft devtunnel start') / $(Cyan 'status') / $(Cyan 'stop')"
    Write-Host ''
}
Write-Host (Dim "Uninstall: Remove-Item -Recurse -Force `"$InstallDir`", `"$weftHome`", `"$skillDir`"")
