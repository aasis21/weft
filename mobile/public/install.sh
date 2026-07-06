#!/usr/bin/env bash
# One-line bootstrap installer for Weft (macOS / Linux).
#
#   curl -fsSL https://useweft.netlify.app/install.sh | bash
#
# Downloads the prebuilt Weft Copilot CLI extension (+ the standalone `weft`
# Device Station command) and drops them where `copilot` auto-discovers extensions
# (~/.copilot/extensions/weft), wired to your chosen relay transport.
# No git clone, no Node build required on your machine.
#
# Choose your transport non-interactively: WEFT_TRANSPORT=supabase|devtunnel
#   curl -fsSL https://useweft.netlify.app/install.sh | WEFT_TRANSPORT=devtunnel bash
#
# Run-your-own relay overrides (env vars):
#   WEFT_SUPABASE_URL=https://xxx.supabase.co WEFT_SUPABASE_ANON_KEY=sb_publishable_xxx \
#     bash -c "$(curl -fsSL https://useweft.netlify.app/install.sh)"
#
# Force overwrite of an existing .env: WEFT_FORCE=1
set -euo pipefail

BASE="https://useweft.netlify.app"
INSTALL_DIR="${WEFT_INSTALL_DIR:-$HOME/.copilot/extensions/weft}"
BIN_DIR="${WEFT_BIN_DIR:-$HOME/.local/bin}"
# Weft-namespaced override env vars: a stray global SUPABASE_URL for another project
# must not change which relay we install.
RELAY_URL="${WEFT_SUPABASE_URL:-https://jqzohxjouzxzawqqlifv.supabase.co}"
RELAY_KEY="${WEFT_SUPABASE_ANON_KEY:-sb_publishable_Rf_bymYhJk9fF2Op4xKT0w_eaWLiyCY}"
TOTAL_STEPS=5

bold()   { printf '\033[1m%s\033[0m' "$1"; }
dim()    { printf '\033[2m%s\033[0m' "$1"; }
cyan()   { printf '\033[36m%s\033[0m' "$1"; }
ok()     { printf '   \033[32m\xE2\x9C\x93\033[0m %s\n' "$1"; }
warn()   { printf '   \033[33m!\033[0m %s\n' "$1"; }
step()   { printf '\n\033[1m[%s/%s]\033[0m %s\n' "$1" "$TOTAL_STEPS" "$2"; }

echo ""
echo "$(bold "$(cyan '=== WEFT INSTALLER ===')")"

# ---------------------------------------------------------------------------
step 1 "Choose your default transport"
TRANSPORT="${WEFT_TRANSPORT:-}"
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
step 2 "Downloading Weft bundles"
mkdir -p "$INSTALL_DIR"
curl -fsSL "$BASE/extension.mjs" -o "$INSTALL_DIR/extension.mjs"
ok "extension.mjs -> $INSTALL_DIR  (the Copilot CLI extension itself)"
# relayServerProcess.mjs is spawned as a DETACHED sibling process by devtunnel.mjs (resolved next
# to extension.mjs at runtime) so the shared devtunnel relay/tunnel can outlive any one CLI
# session - must always be installed alongside extension.mjs, not just on first install.
curl -fsSL "$BASE/relayServerProcess.mjs" -o "$INSTALL_DIR/relayServerProcess.mjs"
ok "relayServerProcess.mjs -> $INSTALL_DIR  (shared devtunnel relay, only spawned if you use devtunnel)"
curl -fsSL "$BASE/weft.mjs" -o "$INSTALL_DIR/weft.mjs"
ok "weft.mjs -> $INSTALL_DIR  (standalone Device Station CLI)"

# ---------------------------------------------------------------------------
step 3 "Writing relay config"
ENV_PATH="$INSTALL_DIR/.env"
if [ -f "$ENV_PATH" ] && [ "${WEFT_FORCE:-0}" != "1" ]; then
  # Auto-migrate an older .env (generic SUPABASE_* only) by adding the namespaced keys,
  # preserving any custom relay values already set. Existing installs self-heal.
  added=""
  if ! grep -qE '^[[:space:]]*WEFT_SUPABASE_URL=' "$ENV_PATH"; then
    existing="$(grep -E '^[[:space:]]*SUPABASE_URL=' "$ENV_PATH" | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
    printf 'WEFT_SUPABASE_URL=%s\n' "${existing:-$RELAY_URL}" >> "$ENV_PATH"
    added="WEFT_SUPABASE_URL"
  fi
  if ! grep -qE '^[[:space:]]*WEFT_SUPABASE_ANON_KEY=' "$ENV_PATH"; then
    existingk="$(grep -E '^[[:space:]]*SUPABASE_ANON_KEY=' "$ENV_PATH" | head -n1 | cut -d= -f2- | tr -d '[:space:]')"
    printf 'WEFT_SUPABASE_ANON_KEY=%s\n' "${existingk:-$RELAY_KEY}" >> "$ENV_PATH"
    added="${added:+$added, }WEFT_SUPABASE_ANON_KEY"
  fi
  if [ -n "$added" ]; then
    ok "migrated your .env to namespaced vars (+$added)"
  else
    ok "kept your existing .env (set WEFT_FORCE=1 to overwrite, or run: weft set-transport $TRANSPORT)"
  fi
else
  cat > "$ENV_PATH" <<EOF
# Weft relay config. The publishable key is client-safe by design; the channel is
# guarded by Supabase RLS + end-to-end AES-256-GCM. To run your own relay, swap these
# for your own Supabase project's URL + publishable key.
#
# Names are Weft-namespaced on purpose: a generic SUPABASE_URL / SUPABASE_ANON_KEY
# exported globally for another Supabase project would otherwise hijack the relay.
#
# Change your default any time with: weft set-transport <supabase|devtunnel>
WEFT_TRANSPORT=$TRANSPORT
WEFT_SUPABASE_URL=$RELAY_URL
WEFT_SUPABASE_ANON_KEY=$RELAY_KEY
WEFT_APPROVAL_TIMEOUT_MS=120000
EOF
  ok "wrote relay config -> $ENV_PATH"
fi

# ---------------------------------------------------------------------------
step 4 'Registering the `weft` command'
mkdir -p "$BIN_DIR"
SHIM_PATH="$BIN_DIR/weft"
cat > "$SHIM_PATH" <<EOF
#!/usr/bin/env bash
exec node "$INSTALL_DIR/weft.mjs" "\$@"
EOF
chmod +x "$SHIM_PATH"
ok "weft -> $SHIM_PATH"
case ":$PATH:" in
  *":$BIN_DIR:"*)
    ok "$BIN_DIR is already on your PATH"
    ;;
  *)
    MARKER="# Added by Weft installer"
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
    warn "Open a NEW terminal (or 'source ~/.profile') for \`weft\` to be found."
    ;;
esac

# ---------------------------------------------------------------------------
step 5 "Done"
echo ""
echo "  $(bold '1.') Start Copilot CLI in any repo (run $(cyan '/weft') to show the QR)."
echo "  $(bold '2.') Open $(cyan 'https://useweft.netlify.app') on your phone and scan the QR."
echo "  $(bold '3.') Trigger a Copilot action and approve / deny from your phone."
echo ""
echo "  Want a station for your phone to spawn Copilot sessions on THIS machine directly"
echo "  (no Copilot CLI open, just this)? Open a new terminal and run: $(cyan 'weft start')"
echo ""
printf '%s\n' "$(dim "Uninstall: rm -rf \"$INSTALL_DIR\" \"$SHIM_PATH\"")"
