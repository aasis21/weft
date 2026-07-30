// The weft CLI's command dispatch must be the LAST thing the module does.
//
// `weft start` and `weft devtunnel start` never return. When the dispatch sat inline at the top
// level, `await start()` suspended module evaluation forever, so every top-level `const` declared
// below it stayed uninitialized for the entire life of the station. Function declarations hoist,
// so most of the file kept working and the breakage looked random. esbuild lowers those `const`s
// to `var` in the shipped bundle, which turns what would be a loud ReferenceError in source into a
// silent `undefined`: the relay watchdog got `setInterval(fn, undefined)` (a ~15ms timer instead
// of 30s), a failure threshold of `undefined` (so it declared the relay wedged without probing it
// even once), and an undefined `stamp()` that threw on every tick.
//
// Encoding the rule as a test rather than a comment, because the comment already existed elsewhere
// in the file and the mistake was still made twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "weft.mjs");

/** Statements at column 0 are module top level; anything indented is inside a function body. */
function topLevelAwaitLines(source) {
  return source
    .split(/\r?\n/)
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => /^await\s/.test(text));
}

function lastMeaningfulLine(source) {
  const lines = source.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    return { text: trimmed, line: i + 1 };
  }
  return null;
}

test("the CLI's only top-level await is the main() call", () => {
  const source = readFileSync(cliPath, "utf8");
  const awaits = topLevelAwaitLines(source);

  assert.equal(
    awaits.length,
    1,
    `bin/weft.mjs must have exactly one top-level await (the main() call) but found ${awaits.length}: ` +
      `${awaits.map((a) => `line ${a.line}: ${a.text}`).join(" | ")}. A long-running command awaited at ` +
      `the top level suspends module evaluation forever, leaving every const below it undefined.`,
  );
  assert.match(
    awaits[0].text,
    /^await main\(\);?$/,
    `the single top-level await should be \`await main();\`, found: ${awaits[0].text}`,
  );
});

test("the main() call is the last statement in the CLI", () => {
  const source = readFileSync(cliPath, "utf8");
  const last = lastMeaningfulLine(source);
  assert.ok(last, "bin/weft.mjs appears to be empty");
  assert.equal(
    last.text,
    "await main();",
    `\`await main();\` must be the final statement of bin/weft.mjs so the whole module is initialized ` +
      `before any command runs — found \`${last.text}\` at line ${last.line}.`,
  );
});

test("no top-level binding is declared after the main() call", () => {
  const source = readFileSync(cliPath, "utf8");
  const lines = source.split(/\r?\n/);
  const mainCall = lines.findIndex((text) => /^await main\(\);?$/.test(text.trim()));
  assert.ok(mainCall >= 0, "could not locate the main() call");

  const stragglers = lines
    .slice(mainCall + 1)
    .map((text, index) => ({ text, line: mainCall + 2 + index }))
    .filter(({ text }) => /^(const|let|var)\s/.test(text));

  assert.deepEqual(
    stragglers,
    [],
    `these top-level bindings sit after the main() call and would be undefined for any command that ` +
      `does not return: ${stragglers.map((s) => `line ${s.line}: ${s.text.trim()}`).join(" | ")}`,
  );
});
