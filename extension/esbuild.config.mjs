import { build } from "esbuild";

await build({
  entryPoints: ["src/extension.mjs"],
  outfile: "dist/extension.mjs",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  sourcemap: true,
  external: ["@github/copilot-sdk", "@github/copilot-sdk/extension"],
  logLevel: "info",
});
