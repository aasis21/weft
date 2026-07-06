import { build } from "esbuild";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const outfile = "dist/extension.mjs";

await build({
  entryPoints: ["src/extension.mjs"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: true,
  external: ["@github/copilot-sdk", "@github/copilot-sdk/extension"],
  // Bundled CommonJS deps (qrcode, supabase transitive deps) call require("fs").
  // In ESM output esbuild's shim throws "Dynamic require of ... is not supported"
  // because `require` is undefined. Re-create a real require from import.meta.url
  // so those built-in requires resolve at runtime.
  banner: {
    js: "import { createRequire as __weftCreateRequire } from 'node:module'; const require = __weftCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

// devtunnel.mjs spawns relayServerProcess.mjs as a DETACHED sibling file (resolved relative to
// its own import.meta.url at runtime — see devtunnel.mjs's RELAY_SERVER_PROCESS_PATH) so the
// shared devtunnel relay/tunnel can outlive any one CLI session. Since the main bundle above
// inlines everything into a single extension.mjs, that sibling file has to be produced (and
// installed) as ITS OWN standalone bundle — otherwise "./relayServerProcess.mjs" resolves to a
// file that was never written to disk. Must be built with the same bundle:true/platform/format so
// it has zero dependency on files outside dist/ once installed.
await build({
  entryPoints: ["src/relayServerProcess.mjs"],
  outfile: "dist/relayServerProcess.mjs",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: true,
  banner: {
    js: "import { createRequire as __weftCreateRequire } from 'node:module'; const require = __weftCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

// weft-cli.mjs (the "Device Station" CLI) imports relative ../src/*.mjs files today, so it only
// works when the FULL repo is checked out — it can't be copied standalone onto a machine that
// just needs to run `weft-cli start` (e.g. a headless "device station" box with no Copilot CLI /
// extension installed at all). Bundle it the same way as the other two entry points so
// dist/weft-cli.mjs is fully self-contained (only real Node built-ins + npm deps inlined) and can
// be installed as a single file + a tiny PATH shim — see ship.ps1 / install.ps1 / install.sh.
await build({
  entryPoints: ["bin/weft-cli.mjs"],
  outfile: "dist/weft-cli.mjs",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: true,
  banner: {
    js: "import { createRequire as __weftCreateRequire } from 'node:module'; const require = __weftCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

// Post-build smoke check: import the freshly built bundle with the host SDK stubbed.
// Reaching the stub means all top-level CJS requires initialized — i.e. the bundle is
// actually loadable by the CLI. Fails the build otherwise (don't ship a dead extension).
register(pathToFileURL("scripts/sdk-stub-hook.mjs").href);
try {
  await import(pathToFileURL(outfile).href);
  console.log("[verify] bundle loaded (did not reach SDK stub, but no require error)");
} catch (err) {
  const msg = err?.message ?? String(err);
  if (msg === "WEFT_SDK_STUB_REACHED") {
    console.log("[verify] bundle loads OK — reached SDK entrypoint past all CJS requires, no callback hooks");
  } else if (msg.startsWith("WEFT_RUNTIME_REJECTS_HOOKS")) {
    console.error(
      "[verify] FAIL: joinSession() is passing callback `hooks` — the Copilot CLI native runtime " +
        "rejects these at session.resume. Use session.on(...) events instead.",
    );
    process.exit(1);
  } else {
    console.error(`[verify] bundle FAILED to load: ${msg}`);
    process.exit(1);
  }
}
