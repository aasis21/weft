// Module customization hook used by the post-build smoke check (esbuild.config.mjs).
// Stubs the external @github/copilot-sdk/extension import so the freshly built bundle
// can be imported without the Copilot CLI host. joinSession throws a sentinel; if the
// bundle's top-level code reaches it, every bundled CommonJS require(...) initialized
// fine — which catches the "Dynamic require of X is not supported" class of CJS->ESM
// bundling regressions (the bug that once shipped a non-loadable extension).
export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "@github/copilot-sdk/extension" ||
    specifier === "@github/copilot-sdk"
  ) {
    return { url: "stub:copilot-sdk", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === "stub:copilot-sdk") {
    return {
      format: "module",
      shortCircuit: true,
      // Replicate the Copilot CLI native runtime's two load-time rules so the build
      // self-verifies against the bugs we actually hit:
      //  1. callback `hooks` are rejected at session.resume (CLI >= 1.0.66);
      //  2. reaching joinSession at all proves every bundled CJS require() initialized
      //     (catches "Dynamic require of X is not supported").
      source:
        "export function joinSession(config){" +
        "  if (config && config.hooks && Object.values(config.hooks).some(Boolean))" +
        "    throw new Error('HELM_RUNTIME_REJECTS_HOOKS: SDK hook callbacks are no longer supported by the native runtime');" +
        "  throw new Error('HELM_SDK_STUB_REACHED');" +
        "}",
    };
  }
  return nextLoad(url, context);
}
