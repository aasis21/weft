# Helm

**Your Copilot command center.** Helm is a secure mobile app that binds to your live
`gh copilot` sessions: watch the token stream, answer permission prompts, send prompts, and
switch modes — all from your phone.

> **Try it now (no install):** **<https://usehelm.netlify.app>** — open on your phone,
> scan the pairing QR your terminal prints (or paste it), and you're bound to the session.

### Install the extension on your laptop

One line. Downloads the prebuilt extension into `~/.copilot/extensions/helm/` (where
Copilot CLI auto-discovers it), pre-wired to the hosted relay — no clone, no Node build:

```powershell
# Windows (PowerShell)
irm https://usehelm.netlify.app/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://usehelm.netlify.app/install.sh | bash
```

Then start `gh copilot` in any repo, open **<https://usehelm.netlify.app>** on your phone,
scan the QR (or run `/helm-pair` to re-show it), and approve/deny from anywhere.

- **Zero-config** — uses the creator's hosted relay (a client-safe publishable key + RLS +
  end-to-end AES-256-GCM; Supabase only ever sees ciphertext).
- **Run your own relay** — installer flags let you point at your own Supabase project:
  `... | iex` becomes
  `& ([scriptblock]::Create((irm https://usehelm.netlify.app/install.ps1))) -SupabaseUrl <url> -SupabaseKey <key>`
  on Windows, or `HELM_SUPABASE_URL=<url> HELM_SUPABASE_KEY=<key> bash -c "$(curl -fsSL https://usehelm.netlify.app/install.sh)"` on Unix.
  Prefer building from source? Use [`setup.ps1` / `setup.sh`](docs/setup.md).
- **Uninstall** — delete `~/.copilot/extensions/helm/`.

> Sibling project to [`aasis21/vox`](https://github.com/aasis21/vox),
> [`aasis21/anya`](https://github.com/aasis21/anya), and
> [`aasis21/engram`](https://github.com/aasis21/engram).

---

## Architecture

```
+------------------------------+        +------------------------------+        +-------------------------------+
| Helm Mobile                  |        |   Supabase Realtime          |        |  Laptop terminal              |
| (React + Capacitor, Android) |        |   Broadcast channel          |        |  gh copilot (parent)          |
|                              |        |   private:helm:<channelId>   |        |   └─ extension.mjs (child)    |
|  • scans QR (channel + pub)  |  WSS   |   • in-memory pub/sub        |  WSS   |   • joinSession()             |
|  • ECDH → AES-256-GCM        | <----> |   • zero DB persistence      | <----> |   • onPermissionRequest→relay |
|  • decrypts token stream     |        |   • RLS-gated private chan   |        |   • on(assistant.message)→push|
|  • native-style approval UI  |        |                              |        |   • session.send(phone prompt)|
|  • prompt + mode controls    |        |                              |        |   • QR via session.log()      |
+------------------------------+        +------------------------------+        +-------------------------------+
        all payloads E2E-encrypted; Supabase sees ciphertext only
```

Three layers, one monorepo:

| Workspace | What it is |
|---|---|
| `extension/` | The Copilot CLI extension (`joinSession`) + a local test **harness** that mimics the phone with no Supabase needed. |
| `shared/` | Contracts imported by **both** ends: message schema, E2E crypto (ECDH→AES-GCM), and a pluggable transport (LocalTransport now → SupabaseTransport later). |
| `mobile/` | React + Vite + Capacitor app (Android first); also ships as a hosted **web app** ([usehelm.netlify.app](https://usehelm.netlify.app)) with in-browser camera QR scanning. |

### Design principles
- **Approval = pure relay of native Copilot behavior.** The extension forwards the *native*
  permission prompt to the phone via `onPermissionRequest` and resolves with the user's tap. No
  custom policy. Only safety net: a configurable **timeout → deny** so a missing phone can't hang
  the agent.
- **Ephemeral relay.** Supabase Realtime Broadcast is in-memory; zero DB persistence in v1.
- **End-to-end encrypted.** ECDH key agreement (public key in the QR, no secret) → AES-256-GCM.
  Supabase only ever sees ciphertext.
- **stdout is sacred.** The CLI reserves stdout for JSON-RPC; all extension UX uses
  `session.log()`.

---

## Runtime & packaging model

- The extension is authored in `extension/src/` and bundled (esbuild) to a single
  `extension/dist/extension.mjs`. `@github/copilot-sdk` is marked **external** (the CLI provides
  it at runtime); everything else (e.g. `@supabase/supabase-js`, `shared/`) is bundled in.
- Install copies `extension/dist/` into `~/.copilot/extensions/helm/`, where Copilot CLI
  auto-discovers it (see `setup.*` / `install.*`). Crypto uses Web Crypto — no native deps.
- For local development you do **not** need to install into `~/.copilot`: run the **harness**
  (`extension/harness/`) which drives the extension logic against `LocalTransport`.

---

## Quick start

```sh
npm install                                 # resolve workspaces (shared, extension, mobile)
npm test -w @aasis21/helm-shared            # crypto + pairing + transport + message tests
node extension/harness/harness.mjs --auto   # full relay loop vs a simulated phone (no Supabase)
npm run build -w @aasis21/helm-extension    # bundle -> extension/dist/extension.mjs
npm run build -w @aasis21/helm-mobile       # Vite production build
cd mobile && npm run dev                    # then pick "Demo / Simulator"
```

See [`docs/setup.md`](docs/setup.md) for the full developer guide.

| Doc | What |
|---|---|
| [`docs/setup.md`](docs/setup.md) | install, verify, run, and Supabase wiring |
| [`docs/pairing.md`](docs/pairing.md) | the ECDH pairing handshake |
| [`docs/security.md`](docs/security.md) | threat model & cryptography |
| [`docs/mode-switching.md`](docs/mode-switching.md) | runtime interactive/plan/autopilot switching |
| [`docs/hosting.md`](docs/hosting.md) | public instance vs self-hosting; operating a relay |

---

## Status

**v1 built end-to-end, with a live hosted relay and web app.** The shared contracts (E2E
crypto, pairing handshake, message protocol, pluggable transport), the CLI extension
(`joinSession`, native permission relay, prompt injection, real `session.rpc.mode.set` mode
switching, on-device approval notifications, lifecycle), its local harness, and the
React/Capacitor app (pairing, live stream, approval cards, prompt composer, mode selector,
session-ended) all build and pass their checks. A real Supabase relay (RLS-gated Broadcast)
is provisioned and the app is deployed at **[usehelm.netlify.app](https://usehelm.netlify.app)**
with one-line installers for the laptop extension.

**Remaining:** a full real-device pass (physical phone ↔ laptop over the live relay), plus
hardening follow-ups (relay rate-limiting, replay sequence numbers). See the phased plan in
the session artifacts.

## License

[Apache-2.0](LICENSE) — permissive, with an explicit patent grant and trademark
reservation; see [`NOTICE`](NOTICE) for attribution. Operating a hosted relay is a
separate concern from the code license — see [`docs/hosting.md`](docs/hosting.md) and
[`TERMS.md`](TERMS.md).
