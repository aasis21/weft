import { build } from "esbuild";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const outfile = "dist/extension.mjs";

// Bake the repo-root VERSION into every bundle so the installed extension/CLI report the right
// version with zero runtime file reads (see src/version.mjs). `define` replaces the bare
// `__WEFT_VERSION__` identifier token with this string literal at build time.
const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
const define = { __WEFT_VERSION__: JSON.stringify(version) };

await build({
  entryPoints: ["src/extension.mjs"],
  outfile,
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: true,
  define,
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

// devtunnel.mjs spawns these as SIBLING files, resolved relative to its own import.meta.url at
// runtime (see RELAY_SERVER_PROCESS_PATH / DEVTUNNEL_HOST_WATCHDOG_PATH). Since the main bundle
// above inlines everything into a single extension.mjs, each sibling has to be produced (and
// installed) as ITS OWN standalone bundle — otherwise "./<name>.mjs" resolves to a file that was
// never written to disk and the spawn dies with ERR_MODULE_NOT_FOUND. Built with the same
// bundle:true/platform/format so they have zero dependency on files outside dist/ once installed.
//
// KEEP IN SYNC: every entry here must also appear in BUNDLE_NAMES in bin/weft.mjs (which is what
// `weft install` / `weft update` actually download) and be copied by ship.ps1 / ship.sh.
// extension/test/bundleEntrypoints.test.mjs enforces that — it scans src/ for sibling-path
// constants and fails if any of them is missing from this list or from BUNDLE_NAMES.
const SIBLING_ENTRYPOINTS = ["relayServerProcess.mjs", "devtunnelHostWatchdog.mjs"];
for (const name of SIBLING_ENTRYPOINTS) {
  await build({
    entryPoints: [`src/${name}`],
    outfile: `dist/${name}`,
    bundle: true,
    platform: "node",
    target: "node18",
    format: "esm",
    sourcemap: true,
    define,
    banner: {
      js: "import { createRequire as __weftCreateRequire } from 'node:module'; const require = __weftCreateRequire(import.meta.url);",
    },
    logLevel: "info",
  });
}

// weft.mjs (the "Device Station" CLI) imports relative ../src/*.mjs files today, so it only
// works when the FULL repo is checked out — it can't be copied standalone onto a machine that
// just needs to run `weft start` (e.g. a headless "device station" box with no Copilot CLI /
// extension installed at all). Bundle it the same way as the other two entry points so
// dist/weft.mjs is fully self-contained (only real Node built-ins + npm deps inlined) and can
// be installed as a single file + a tiny PATH shim — see ship.ps1 / install.ps1 / install.sh.
await build({
  entryPoints: ["bin/weft.mjs"],
  outfile: "dist/weft.mjs",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: true,
  define,
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
