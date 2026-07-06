#!/usr/bin/env bash
# One-line bootstrap installer for Helm (macOS / Linux).
#
#   curl -fsSL https://usehelm.netlify.app/install.sh | bash
#
# Downloads the prebuilt Helm Copilot CLI extension (+ the standalone `helm-cli`
# Device Station command) and drops them where `copilot` auto-discovers extensions
# (~/.copilot/extensions/helm), wired to your chosen relay transport.
# No git clone, no Node build required on your machine.
#
# Choose your transport non-interactively: HELM_TRANSPORT=supabase|devtunnel
#   curl -fsSL https://usehelm.netlify.app/install.sh | HELM_TRANSPORT=devtunnel bash
#
# Run-your-own relay overrides (env vars):
#   HELM_SUPABASE_URL=https://xxx.supabase.co HELM_SUPABASE_KEY=sb_publishable_xxx \
#     bash -c "$(curl -fsSL https://usehelm.netlify.app/install.sh)"
#
# Force overwrite of an existing .env: HELM_FORCE=1
set -euo pipefail

BASE="https://usehelm.netlify.app"
INSTALL_DIR="${HELM_INSTALL_DIR:-$HOME/.copilot/extensions/helm}"
BIN_DIR="${HELM_BIN_DIR:-$HOME/.local/bin}"
# Helm-namespaced override env vars: a stray global SUPABASE_URL for another project
# must not change which relay we install.
RELAY_URL="${HELM_SUPABASE_URL:-https://jqzohxjouzxzawqqlifv.supabase.co}"
RELAY_KEY="${HELM_SUPABASE_KEY:-sb_publishable_Rf_bymYhJk9fF2Op4xKT0w_eaWLiyCY}"
TOTAL_STEPS=5

bold()   { printf '\033[1m%s\033[0m' "$1"; }
dim()    { printf '\033[2m%s\033[0m' "$1"; }
cyan()   { printf '\033[36m%s\033[0m' "$1"; }
ok()     { printf '   \033[32m\xE2\x9C\x93\033[0m %s\n' "$1"; }
warn()   { printf '   \033[33m!\033[0m %s\n' "$1"; }
step()   { printf '\n\033[1m[%s/%s]\033[0m %s\n' "$1" "$TOTAL_STEPS" "$2"; }

echo ""
echo "$(bold "$(cyan '=== HELM INSTALLER ===')")"

# ---------------------------------------------------------------------------
step 1 "Choose your default transport"
TRANSPORT="${HELM_TRANSPORT:-}"
if [ -z "$TRANSPORT" ]; then
  if [ -t 0 ] && [ -t 1 ]; then
    echo "   $(bold '1.') supabase   $(dim '- hosted relay, zero config, works anywhere (default)')"
    echo "   $(bold '2.') devtunnel  $(dim '- self-hosted local relay via Microsoft Dev Tunnels, no cloud account')"
    printf "   Pick [1]: "
    read -r choice </dev/tty || choice=""
    case "$choice" in
      2) TRANSPORT="devtunnel" ;;
      *) TRANSPORT="supabase" ;;
    esac
  else
    TRANSPORT="supabase"
  fi
fi
ok "Transport: $TRANSPORT"
if [ "$TRANSPORT" = "devtunnel" ]; then
  if ! command -v devtunnel >/dev/null 2>&1; then
    warn "The \`devtunnel\` CLI was not found on PATH."
    echo "      Install it: https://aka.ms/devtunnels/download"
    echo "      Then log in once with: devtunnel user login -g"
  fi
fi

# ---------------------------------------------------------------------------
step 2 "Downloading Helm bundles"
mkdir -p "$INSTALL_DIR"
curl -fsSL "$BASE/extension.mjs" -o "$INSTALL_DIR/extension.mjs"
ok "extension.mjs -> $INSTALL_DIR  (the Copilot CLI extension itself)"
# relayServerProcess.mjs is spawned as a DETACHED sibling process by devtunnel.mjs (resolved next
# to extension.mjs at runtime) so the shared devtunnel relay/tunnel can outlive any one CLI
# session - must always be installed alongside extension.mjs, not just on first install.
curl -fsSL "$BASE/relayServerProcess.mjs" -o "$INSTALL_DIR/relayServerProcess.mjs"
ok "relayServerProcess.mjs -> $INSTALL_DIR  (shared devtunnel relay, only spawned if you use devtunnel)"
curl -fsSL "$BASE/helm-cli.mjs" -o "$INSTALL_DIR/helm-cli.mjs"
ok "helm-cli.mjs -> $INSTALL_DIR  (standalone Device Station CLI)"

# ---------------------------------------------------------------------------
step 3 "Writing relay config"
ENV_PATH="$INSTALL_DIR/.env"
if [ -f "$ENV_PATH" ] && [ "${HELM_FORCE:-0}" != "1" ]; then
  # Auto-migrate an older .env (generic SUPABASE_* only) by adding the namespaced keys,
  # preserving any custom relay values already set. Existing installs self-heal.
  added=""
  if ! grep -qE '^[[:space:]]*HELM_SUPABASE_URL=' "$ENV_PATH"; then
    existing="$(grep -E '^[[:space:]]*SUPABASE_URL=' "$ENV_PATH" | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
    printf 'HELM_SUPABASE_URL=%s\n' "${existing:-$RELAY_URL}" >> "$ENV_PATH"
    added="HELM_SUPABASE_URL"
  fi
  if ! grep -qE '^[[:space:]]*HELM_SUPABASE_ANON_KEY=' "$ENV_PATH"; then
    existingk="$(grep -E '^[[:space:]]*SUPABASE_ANON_KEY=' "$ENV_PATH" | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
    printf 'HELM_SUPABASE_ANON_KEY=%s\n' "${existingk:-$RELAY_KEY}" >> "$ENV_PATH"
    added="${added:+$added, }HELM_SUPABASE_ANON_KEY"
  fi
  if [ -n "$added" ]; then
    ok "migrated your .env to namespaced vars (+$added)"
  else
    ok "kept your existing .env (set HELM_FORCE=1 to overwrite, or run: helm-cli set-transport $TRANSPORT)"
  fi
else
  cat > "$ENV_PATH" <<EOF
# Helm relay config. The publishable key is client-safe by design; the channel is
# guarded by Supabase RLS + end-to-end AES-256-GCM. To run your own relay, swap these
# for your own Supabase project's URL + publishable key.
#
# Names are Helm-namespaced on purpose: a generic SUPABASE_URL / SUPABASE_ANON_KEY
# exported globally for another Supabase project would otherwise hijack the relay.
#
# Change your default any time with: helm-cli set-transport <supabase|devtunnel>
HELM_TRANSPORT=$TRANSPORT
HELM_SUPABASE_URL=$RELAY_URL
HELM_SUPABASE_ANON_KEY=$RELAY_KEY
HELM_APPROVAL_TIMEOUT_MS=120000
EOF
  ok "wrote relay config -> $ENV_PATH"
fi

# ---------------------------------------------------------------------------
step 4 'Registering the `helm-cli` command'
mkdir -p "$BIN_DIR"
SHIM_PATH="$BIN_DIR/helm-cli"
cat > "$SHIM_PATH" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/helm-cli.mjs" "\$@"
EOF
chmod +x "$SHIM_PATH"
ok "helm-cli -> $SHIM_PATH"
case ":$PATH:" in
  *":$BIN_DIR:"*)
    ok "$BIN_DIR is already on your PATH"
    ;;
  *)
    MARKER="# Added by Helm installer"
    for rc in "$HOME/.profile" "$HOME/.bashrc" "$HOME/.zshrc"; do
      [ -f "$rc" ] || continue
      if ! grep -qF "$MARKER" "$rc" 2>/dev/null; then
        {
          echo ""
          echo "$MARKER"
          echo "export PATH=\"$BIN_DIR:\$PATH\""
        } >> "$rc"
      fi
    done
    warn "Added $BIN_DIR to PATH in your shell rc file(s)."
    warn "Open a NEW terminal (or 'source ~/.profile') for \`helm-cli\` to be found."
    ;;
esac

# ---------------------------------------------------------------------------
step 5 "Done"
echo ""
echo "  $(bold '1.') Start Copilot CLI in any repo (run $(cyan '/helm') to show the QR)."
echo "  $(bold '2.') Open $(cyan 'https://usehelm.netlify.app') on your phone and scan the QR."
echo "  $(bold '3.') Trigger a Copilot action and approve / deny from your phone."
echo ""
echo "  Want a station for your phone to spawn Copilot sessions on THIS machine directly"
echo "  (no Copilot CLI open, just this)? Open a new terminal and run: $(cyan 'helm-cli start')"
echo ""
printf '%s\n' "$(dim "Uninstall: rm -rf \"$INSTALL_DIR\" \"$SHIM_PATH\"")"
