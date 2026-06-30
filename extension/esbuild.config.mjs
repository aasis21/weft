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
    js: "import { createRequire as __helmCreateRequire } from 'node:module'; const require = __helmCreateRequire(import.meta.url);",
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
  if (msg === "HELM_SDK_STUB_REACHED") {
    console.log("[verify] bundle loads OK — reached SDK entrypoint past all CJS requires, no callback hooks");
  } else if (msg.startsWith("HELM_RUNTIME_REJECTS_HOOKS")) {
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
