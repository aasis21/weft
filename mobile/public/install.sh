#!/usr/bin/env bash
# One-line bootstrap installer for Weft (macOS / Linux).
#
#   curl -fsSL https://useweft.netlify.app/install.sh | bash
#
# Downloads the prebuilt Weft Copilot CLI extension (+ the standalone `weft`
# Device Station command) and drops them where `copilot` auto-discovers extensions
# (~/.copilot/extensions/weft - CODE only). Also installs a "how to use Weft" skill to
# ~/.copilot/skills/weft-how-to-use/SKILL.md, the same way the extension goes to
# ~/.copilot/extensions/weft, so the agent can answer usage questions directly. All user
# config (projects, transport choice) lives separately in ~/.weft/weft.config.json, written
# via `weft set-transport` - there is NO env var / .env for this, so re-running this
# installer to update to a newer build never silently resets or shadows your chosen
# transport. No git clone, no Node build required on your machine (just Node itself).
#
# Choose your transport non-interactively: WEFT_TRANSPORT=supabase|devtunnel
#   curl -fsSL https://useweft.netlify.app/install.sh | WEFT_TRANSPORT=devtunnel bash
#
# Run-your-own relay overrides (env vars, used only to seed weft set-transport - not stored
# as env vars anywhere):
#   WEFT_SUPABASE_URL=https://xxx.supabase.co WEFT_SUPABASE_ANON_KEY=sb_publishable_xxx \
#     bash -c "$(curl -fsSL https://useweft.netlify.app/install.sh)"
#
# Force re-applying the transport even if one is already configured: WEFT_FORCE=1
set -euo pipefail

BASE="https://useweft.netlify.app"
INSTALL_DIR="${WEFT_INSTALL_DIR:-$HOME/.copilot/extensions/weft}"
BIN_DIR="${WEFT_BIN_DIR:-$HOME/.local/bin}"
WEFT_HOME="$HOME/.weft"
WEFT_CONFIG_PATH="$WEFT_HOME/weft.config.json"
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
# Step 1: pick a transport. An existing ~/.weft/weft.config.json choice always wins unless the
# caller explicitly set WEFT_TRANSPORT or WEFT_FORCE=1 - this installer only ever refreshes CODE
# under $INSTALL_DIR, never the user's config, so a plain re-run/upgrade can't silently reset it.
# ---------------------------------------------------------------------------
step 1 "Choose your default transport"
TRANSPORT="${WEFT_TRANSPORT:-}"
TRANSPORT_EXPLICIT=1; [ -z "$TRANSPORT" ] && TRANSPORT_EXPLICIT=0
FORCE="${WEFT_FORCE:-0}"
EXISTING_TRANSPORT_KIND=""
if [ -f "$WEFT_CONFIG_PATH" ]; then
  EXISTING_TRANSPORT_KIND="$(node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const kind = cfg && cfg.transport && cfg.transport.kind;
      if (kind === "supabase" || kind === "devtunnel") process.stdout.write(kind);
    } catch {}
  ' "$WEFT_CONFIG_PATH" 2>/dev/null || true)"
fi

APPLY_TRANSPORT=1
LEGACY_ENV_PATHS=("$INSTALL_DIR/.env" "$WEFT_HOME/.env")
if [ -n "$EXISTING_TRANSPORT_KIND" ] && [ "$TRANSPORT_EXPLICIT" != "1" ] && [ "$FORCE" != "1" ]; then
  TRANSPORT="$EXISTING_TRANSPORT_KIND"
  APPLY_TRANSPORT=0
  ok "Existing transport config found ($TRANSPORT) -> $WEFT_CONFIG_PATH - left untouched."
  echo "      $(dim "Set WEFT_TRANSPORT=<name> or WEFT_FORCE=1 to change it.")"
else
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
fi
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
# The "how to use Weft" skill goes to ~/.copilot/skills/weft-how-to-use/SKILL.md - same convention as the
# extension going to ~/.copilot/extensions/weft - so the agent can answer "how do I pair my
# phone" / "how do I switch transport" etc. without the user having to ask us directly.
SKILL_DIR="$HOME/.copilot/skills/weft-how-to-use"
mkdir -p "$SKILL_DIR"
curl -fsSL "$BASE/weft-skill.md" -o "$SKILL_DIR/SKILL.md"
ok "SKILL.md -> $SKILL_DIR  (how-to-use skill for the Copilot CLI agent)"

# ---------------------------------------------------------------------------
# Step 3: apply the transport choice to ~/.weft/weft.config.json - the ONLY place the extension
# and weft.mjs ever read transport config from (no env var, no .env - see transportConfig.mjs /
# transportFactory.mjs). Calls the just-downloaded weft.mjs's own `set-transport` command so this
# installer never has to duplicate its validation/persistence logic. A stale .env from an older
# install (that config format is retired, no migration) is simply removed so it can't linger
# around looking authoritative when it's now inert.
# ---------------------------------------------------------------------------
step 3 "Applying transport config"
mkdir -p "$WEFT_HOME"

for p in "${LEGACY_ENV_PATHS[@]}"; do
  if [ -f "$p" ]; then
    rm -f "$p"
    ok "removed stale $p  (config now lives only in weft.config.json)"
  fi
done

if [ "$APPLY_TRANSPORT" = "1" ]; then
  if [ "$TRANSPORT" = "supabase" ]; then
    node "$INSTALL_DIR/weft.mjs" set-transport supabase --url "$RELAY_URL" --anon-key "$RELAY_KEY" >/dev/null
  else
    node "$INSTALL_DIR/weft.mjs" set-transport devtunnel >/dev/null
  fi
  ok "wrote transport config ($TRANSPORT) -> $WEFT_CONFIG_PATH"
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
if [ "$TRANSPORT" = "devtunnel" ]; then
  echo "  Using devtunnel: provision/check/tear down the shared relay any time, independent"
  echo "  of any pairing session, with: $(cyan 'weft devtunnel start') / $(cyan 'status') / $(cyan 'stop')"
  echo ""
fi
printf '%s\n' "$(dim "Uninstall: rm -rf \"$INSTALL_DIR\" \"$SHIM_PATH\" \"$HOME/.weft\" \"$SKILL_DIR\"")"
