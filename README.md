# Helm

**Your Copilot command center.** Helm is a secure mobile app that binds to your live
`gh copilot` sessions: watch the token stream, answer permission prompts, send prompts, and
switch modes — all from your phone.

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
| `mobile/` | React + Vite + Capacitor app (Android first). |

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

**v1 vertical slice built and verified over the in-process transport.** The shared
contracts (E2E crypto, pairing handshake, message protocol, pluggable transport), the
CLI extension (`joinSession`, native permission relay, prompt injection, real
`session.rpc.mode.set` mode switching, lifecycle), its local harness, and the
React/Capacitor mobile app (pairing, live stream, approval cards, prompt composer, mode
selector, session-ended) all build and pass their checks against `LocalTransport`.

**Remaining (user-gated):** stand up a fresh Supabase project + RLS and flip
`HELM_TRANSPORT=supabase` for real cross-device pairing, then a real-device pass against a
live `gh copilot` session. See the phased plan in the session artifacts.

## License

[Apache-2.0](LICENSE) — permissive, with an explicit patent grant and trademark
reservation; see [`NOTICE`](NOTICE) for attribution. Operating a hosted relay is a
separate concern from the code license — see [`docs/hosting.md`](docs/hosting.md) and
[`TERMS.md`](TERMS.md).
