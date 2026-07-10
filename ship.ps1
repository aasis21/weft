#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One command to ship Weft: build -> refresh the hosted "site bits" -> deploy to
  Netlify -> install the extension on THIS laptop. Optionally git push.

.DESCRIPTION
  Runs the whole release pipeline the docs describe, in the only order that is correct
  (the mobile build must happen AFTER the fresh extension bundle is copied into
  mobile/public, so the deployed site serves the latest one-line installer):

    1. Build the Copilot CLI extension      (esbuild -> extension/dist/extension.mjs)
    2. Refresh site bits                     (copy that bundle -> mobile/public/extension.mjs,
                                              the gitignored deploy-time artifact the hosted
                                              `irm .../install.ps1 | iex` installer downloads)
    3. Build the mobile web app              (Vite -> mobile/dist, embedding the fresh
                                              extension.mjs + install.ps1/.sh + headers)
    4. Deploy mobile/dist to Netlify         (site `useweft`, production by default)
    5. Install the extension on this laptop  (-> ~/.copilot/extensions/weft; transport config
                                              stays untouched in ~/.weft/weft.config.json)

  Mobile web build reads relay creds from mobile/.env.local (Vite build-time only). The local
  extension's transport is NOT env/`.env`-based at all: it is read exclusively from
  ~/.weft/weft.config.json, written by `weft set-transport`, and this script never writes or
  overwrites that file. Nothing secret is written into the repo.

.PARAMETER Site         Netlify site name or id (default: useweft).
.PARAMETER Draft        Deploy a Netlify preview (draft) instead of production.
.PARAMETER Push         Run `git push` for the current branch after a successful pipeline.
.PARAMETER SkipBuild    Reuse the existing extension/dist + mobile/dist (no rebuild).
.PARAMETER SkipDeploy   Skip the Netlify deploy step.
.PARAMETER SkipInstall  Skip the local ~/.copilot install step.

.EXAMPLE
  ./ship.ps1                      # build + refresh + deploy prod + install on this laptop
.EXAMPLE
  ./ship.ps1 -Draft              # same, but a Netlify preview deploy (safe dry run of the site)
.EXAMPLE
  ./ship.ps1 -SkipDeploy -Push   # build + install locally + push code, no site deploy
#>
[CmdletBinding()]
param(
    [string]$Site = '137f2a7d-1dcf-43bd-8c0e-fdaec08835a7',  # useweft (id; name lookup is flaky from a workspace root)
    [switch]$Draft,
    [switch]$Push,
    [switch]$SkipBuild,
    [switch]$SkipDeploy,
    [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $root

function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Info($m) { Write-Host "  ..  $m" -ForegroundColor DarkGray }
function Warn($m) { Write-Host "  !!  $m" -ForegroundColor Yellow }

try {
    $extBundle    = Join-Path $root 'extension\dist\extension.mjs'
    $relayBundle  = Join-Path $root 'extension\dist\relayServerProcess.mjs'
    $weftCliBundle = Join-Path $root 'extension\dist\weft.mjs'
    $publicBundle = Join-Path $root 'mobile\public\extension.mjs'
    $distDir      = Join-Path $root 'mobile\dist'

    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        Step 'Installing workspace dependencies (npm install)'
        npm install | Out-Null
        Ok 'dependencies ready'
    }

    if (-not $SkipBuild) {
        Step 'Building extension (esbuild)'
        npm run build -w '@aasis21/weft-extension' | Out-Null
        if (-not (Test-Path $extBundle)) { throw "extension build did not produce $extBundle" }
        Ok 'extension/dist/extension.mjs'
        if (-not (Test-Path $relayBundle)) { throw "extension build did not produce $relayBundle" }
        Ok 'extension/dist/relayServerProcess.mjs  (spawned detached for the shared devtunnel relay)'
        if (-not (Test-Path $weftCliBundle)) { throw "extension build did not produce $weftCliBundle" }
        Ok 'extension/dist/weft.mjs  (standalone Device Station CLI, no repo checkout needed)'

        Step 'Refreshing site bits (extension bundle -> mobile/public)'
        Copy-Item $extBundle $publicBundle -Force
        Ok 'mobile/public/extension.mjs  (served as /extension.mjs by the installer)'
        $publicRelayBundle = Join-Path $root 'mobile\public\relayServerProcess.mjs'
        Copy-Item $relayBundle $publicRelayBundle -Force
        Ok 'mobile/public/relayServerProcess.mjs  (served as /relayServerProcess.mjs by the installer)'
        $publicWeftCliBundle = Join-Path $root 'mobile\public\weft.mjs'
        Copy-Item $weftCliBundle $publicWeftCliBundle -Force
        Ok 'mobile/public/weft.mjs  (served as /weft.mjs by the installer)'
        $skillSource = Join-Path $root 'skill\weft-how-to-use\SKILL.md'
        $publicSkillBundle = Join-Path $root 'mobile\public\weft-skill.md'
        if (Test-Path $skillSource) {
            Copy-Item $skillSource $publicSkillBundle -Force
            Ok 'mobile/public/weft-skill.md  (served as /weft-skill.md; installer writes it to ~/.copilot/skills/weft-how-to-use/SKILL.md)'
        } else {
            Warn "no $skillSource - the how-to-use skill won't be (re)published"
        }

        Step 'Building mobile web app (Vite)'
        npm run build -w '@aasis21/weft-mobile' | Out-Null
        if (-not (Test-Path (Join-Path $distDir 'index.html'))) { throw "mobile build did not produce $distDir" }
        Ok 'mobile/dist'

        # The Android APK lives in mobile/release/ (NOT mobile/public/) so `cap sync` never bundles
        # it into the native app's own assets. It's only stitched into the web dist here, so the
        # hosted /app download page (mobile/public/app.html) has something to link to.
        $apkSource = Join-Path $PSScriptRoot 'mobile\release\weft-debug.apk'
        if (Test-Path $apkSource) {
            Copy-Item $apkSource (Join-Path $distDir 'weft-debug.apk') -Force
            Ok 'mobile/dist/weft-debug.apk  (served as /weft-debug.apk for the /app download page)'
        } else {
            Info 'No mobile/release/weft-debug.apk yet - /app download page will 404 until one is built'
        }
    } else {
        Info 'SkipBuild: reusing existing extension/dist and mobile/dist'
        if (-not (Test-Path $extBundle)) { throw "no $extBundle - run once without -SkipBuild first" }
        if (-not (Test-Path $relayBundle)) { throw "no $relayBundle - run once without -SkipBuild first" }
        if (-not (Test-Path $weftCliBundle)) { throw "no $weftCliBundle - run once without -SkipBuild first" }
        if (-not (Test-Path (Join-Path $distDir 'index.html'))) { throw "no $distDir - run once without -SkipBuild first" }
    }

    if (-not $SkipDeploy) {
        $kind = if ($Draft) { 'preview (draft)' } else { 'production' }
        Step "Deploying mobile/dist to Netlify [$Site] - $kind"
        # --no-build: we already built mobile/dist above; just upload it. --filter resolves the
        # npm-workspace monorepo so the CLI does not prompt. Site is referenced by id (the name
        # lookup is unreliable from a workspaces root).
        $deployArgs = @('deploy', '--no-build', '--filter', '@aasis21/weft-mobile', '--dir', $distDir, '--site', $Site, '--message', "ship.ps1 $(Get-Date -Format s)")
        if (-not $Draft) { $deployArgs += '--prod' }
        & netlify @deployArgs
        if ($LASTEXITCODE -ne 0) {
            throw "netlify deploy failed ($LASTEXITCODE). Try 'netlify login' and confirm this account can access site '$Site'."
        }
        Ok "$kind deploy complete"
    } else { Info 'SkipDeploy' }

    if (-not $SkipInstall) {
        Step 'Installing extension on this laptop (~/.copilot/extensions/weft)'
        if (-not (Test-Path $extBundle)) { throw "no $extBundle to install - drop -SkipBuild" }
        $dest = Join-Path $env:USERPROFILE '.copilot\extensions\weft'
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        Copy-Item $extBundle (Join-Path $dest 'extension.mjs') -Force
        Ok "extension.mjs -> $dest"
        if (Test-Path $relayBundle) {
            Copy-Item $relayBundle (Join-Path $dest 'relayServerProcess.mjs') -Force
            Ok "relayServerProcess.mjs -> $dest  (must sit next to extension.mjs - devtunnel.mjs resolves it as a sibling file at runtime)"
        } else {
            Warn "no $relayBundle - /weft devtunnel will fail to spawn the shared relay until rebuilt"
        }
        if (Test-Path $weftCliBundle) {
            Copy-Item $weftCliBundle (Join-Path $dest 'weft.mjs') -Force
            Ok "weft.mjs -> $dest  (standalone Device Station CLI)"
            $shimPath = Join-Path $dest 'weft.cmd'
            @"
@echo off
node "%~dp0weft.mjs" %*
"@ | Set-Content -Path $shimPath -Encoding ascii
            $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
            $pathEntries = @()
            if ($userPath) { $pathEntries = $userPath -split ';' | Where-Object { $_ } }
            if ($pathEntries -notcontains $dest) {
                [Environment]::SetEnvironmentVariable('Path', (($pathEntries + $dest) -join ';'), 'User')
                Ok "weft.cmd -> $dest  (added $dest to your User PATH - open a NEW terminal for it to take effect)"
            } else {
                Ok "weft.cmd -> $dest  (already on your PATH)"
            }
        } else {
            Warn "no $weftCliBundle - the standalone \`weft\` command was not (re)installed"
        }
        $skillSource = Join-Path $root 'skill\weft-how-to-use\SKILL.md'
        if (Test-Path $skillSource) {
            $skillDest = Join-Path $env:USERPROFILE '.copilot\skills\weft-how-to-use'
            New-Item -ItemType Directory -Force -Path $skillDest | Out-Null
            Copy-Item $skillSource (Join-Path $skillDest 'SKILL.md') -Force
            Ok "SKILL.md -> $skillDest  (how-to-use skill, alongside the extension)"
        } else {
            Warn "no $skillSource - the how-to-use skill was not (re)installed"
        }
        # Transport lives in a single file, ~/.weft/weft.config.json, written only by `weft
        # set-transport` — ship.ps1 never touches it, so reinstalling/rebuilding the extension can
        # never silently overwrite (or be shadowed by) the user's chosen transport.
        $weftHome = Join-Path $env:USERPROFILE '.weft'
        New-Item -ItemType Directory -Force -Path $weftHome | Out-Null
        $weftConfig = Join-Path $weftHome 'weft.config.json'
        if (Test-Path $weftConfig) {
            Ok "transport config untouched -> $weftConfig"
        } else {
            Warn "no transport configured yet - run: weft set-transport supabase --url <url> --anon-key <key>"
        }
    } else { Info 'SkipInstall' }

    if ($Push) {
        Step 'git push (current branch)'
        git push
        if ($LASTEXITCODE -ne 0) { throw 'git push failed' }
        Ok 'pushed'
    }

    Step 'Done'
    if (-not $SkipDeploy -and -not $Draft) {
        Write-Host '  Site:      https://useweft.netlify.app' -ForegroundColor Green
        Write-Host '  Installer: irm https://useweft.netlify.app/install.ps1 | iex' -ForegroundColor Green
    }
    if (-not $SkipInstall) {
        # ship.ps1 can only refresh the files in ~/.copilot/extensions/weft; the running Copilot
        # CLI still holds the OLD bundle in memory. When this script is run BY the Copilot agent,
        # the agent should immediately call its `extensions_reload` tool to hot-load the new
        # extension.mjs from disk (no `copilot` restart needed). Outside the agent, restart `copilot`.
        Write-Host '  Local CLI: call the `extensions_reload` agent tool to hot-load the new bundle' -ForegroundColor Green
        Write-Host '             (or restart `copilot` if not running under the agent); then /weft for the QR.' -ForegroundColor Green
    }
}
finally {
    Pop-Location
}
