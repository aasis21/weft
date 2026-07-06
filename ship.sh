#!/usr/bin/env bash
# One command to ship Weft: build -> refresh the hosted "site bits" -> deploy to
# Netlify -> install the extension on THIS laptop. Optionally git push.
# See ship.ps1 for the Windows/PowerShell version and full docs.
#
# Pipeline (the order matters: the mobile build must run AFTER the fresh extension
# bundle is copied into mobile/public, so the deployed site serves the latest installer):
#   1. Build the extension      (esbuild  -> extension/dist/extension.mjs)
#   2. Refresh site bits        (copy that -> mobile/public/extension.mjs, the gitignored
#                                deploy-time artifact the hosted install.sh downloads)
#   3. Build the mobile web app (Vite      -> mobile/dist)
#   4. Deploy mobile/dist to Netlify (site useweft, production by default)
#   5. Install the extension    (-> ~/.copilot/extensions/weft + colocated .env)
#
# Usage:
#   ./ship.sh                     # build + refresh + deploy prod + install on this laptop
#   ./ship.sh --draft             # Netlify preview deploy instead of production
#   ./ship.sh --push              # also `git push` the current branch
#   ./ship.sh --skip-deploy       # build + install locally only
#   ./ship.sh --site my-site      # target a different Netlify site
set -euo pipefail

SITE="137f2a7d-1dcf-43bd-8c0e-fdaec08835a7"  # useweft (id; name lookup is flaky from a workspace root)
DRAFT=0; PUSH=0; SKIP_BUILD=0; SKIP_DEPLOY=0; SKIP_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --site) SITE="$2"; shift 2;;
    --draft) DRAFT=1; shift;;
    --push) PUSH=1; shift;;
    --skip-build) SKIP_BUILD=1; shift;;
    --skip-deploy) SKIP_DEPLOY=1; shift;;
    --skip-install) SKIP_INSTALL=1; shift;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$root"

cyan(){ printf '\n\033[36m=== %s ===\033[0m\n' "$1"; }
ok(){   printf '\033[32m  OK  %s\033[0m\n' "$1"; }
info(){ printf '\033[90m  ..  %s\033[0m\n' "$1"; }
warn(){ printf '\033[33m  !!  %s\033[0m\n' "$1"; }

ext_bundle="$root/extension/dist/extension.mjs"
public_bundle="$root/mobile/public/extension.mjs"
dist_dir="$root/mobile/dist"

if [ ! -d "$root/node_modules" ]; then
  cyan "Installing workspace dependencies (npm install)"
  npm install >/dev/null
  ok "dependencies ready"
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  cyan "Building extension (esbuild)"
  npm run build -w @aasis21/weft-extension >/dev/null
  [ -f "$ext_bundle" ] || { echo "extension build did not produce $ext_bundle" >&2; exit 1; }
  ok "extension/dist/extension.mjs"

  cyan "Refreshing site bits (extension bundle -> mobile/public)"
  cp "$ext_bundle" "$public_bundle"
  ok "mobile/public/extension.mjs  (served as /extension.mjs by the installer)"

  cyan "Building mobile web app (Vite)"
  npm run build -w @aasis21/weft-mobile >/dev/null
  [ -f "$dist_dir/index.html" ] || { echo "mobile build did not produce $dist_dir" >&2; exit 1; }
  ok "mobile/dist"
else
  info "skip-build: reusing existing extension/dist and mobile/dist"
  [ -f "$ext_bundle" ] || { echo "no $ext_bundle - run once without --skip-build first" >&2; exit 1; }
  [ -f "$dist_dir/index.html" ] || { echo "no $dist_dir - run once without --skip-build first" >&2; exit 1; }
fi

if [ "$SKIP_DEPLOY" -eq 0 ]; then
  kind=$([ "$DRAFT" -eq 1 ] && echo "preview (draft)" || echo "production")
  cyan "Deploying mobile/dist to Netlify [$SITE] - $kind"
  # --no-build: mobile/dist is already built above; just upload it. --filter resolves the
  # npm-workspace monorepo so the CLI does not prompt. Site referenced by id.
  args=(deploy --no-build --filter @aasis21/weft-mobile --dir "$dist_dir" --site "$SITE" --message "ship.sh $(date +%FT%T)")
  [ "$DRAFT" -eq 1 ] || args+=(--prod)
  if ! netlify "${args[@]}"; then
    echo "netlify deploy failed. Try 'netlify login' and confirm access to site '$SITE'." >&2
    exit 1
  fi
  ok "$kind deploy complete"
else
  info "skip-deploy"
fi

if [ "$SKIP_INSTALL" -eq 0 ]; then
  cyan "Installing extension on this laptop (~/.copilot/extensions/weft)"
  [ -f "$ext_bundle" ] || { echo "no $ext_bundle to install - drop --skip-build" >&2; exit 1; }
  dest="$HOME/.copilot/extensions/weft"
  mkdir -p "$dest"
  cp "$ext_bundle" "$dest/extension.mjs"
  ok "extension.mjs -> $dest"
  if [ -f "$root/.env" ]; then
    cp "$root/.env" "$dest/.env"
    ok "copied .env (relay credentials) next to the extension"
  else
    warn "no .env at repo root - set WEFT_SUPABASE_URL / WEFT_SUPABASE_ANON_KEY / WEFT_TRANSPORT before 'copilot'"
  fi
else
  info "skip-install"
fi

if [ "$PUSH" -eq 1 ]; then
  cyan "git push (current branch)"
  git push
  ok "pushed"
fi

cyan "Done"
if [ "$SKIP_DEPLOY" -eq 0 ] && [ "$DRAFT" -eq 0 ]; then
  printf '\033[32m  Site:      https://useweft.netlify.app\033[0m\n'
  printf '\033[32m  Installer: curl -fsSL https://useweft.netlify.app/install.sh | bash\033[0m\n'
fi
[ "$SKIP_INSTALL" -eq 0 ] && printf '\033[32m  Local CLI: restart copilot to load the new extension; run /weft to show the QR.\033[0m\n'
