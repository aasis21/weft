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
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

test("bare weft opens the dashboard while explicit help and UI status do not", async () => {
  const loader = `export async function load(url, context, nextLoad) {
    if (url.endsWith('/src/controlCenter.mjs')) return {
      format: 'module', shortCircuit: true,
      source: \`
        export async function openControlCenter(options) { console.log('TEST_CONTROL_CENTER_OPENED browser=' + options.browserMode); }
        export async function inspectControlCenter() { return null; }
        export async function stopControlCenter() {}
        export async function createControlCenterHost() {}
      \`
    };
    return nextLoad(url, context);
  }`;
  const registration = "import { register } from 'node:module'; register(" +
    JSON.stringify("data:text/javascript," + encodeURIComponent(loader)) + ");";
  const run = (args) => promisify(execFile)(process.execPath,
    ["--import", "data:text/javascript," + encodeURIComponent(registration), cliPath, ...args],
    { timeout: 20_000, windowsHide: true });
  for (const args of [[], ["ui"]]) {
    const { stdout } = await run(args);
    assert.match(stdout, /TEST_CONTROL_CENTER_OPENED/);
    assert.doesNotMatch(stdout, /Usage:/);
  }
  for (const args of [["help"], ["--help"], ["-h"]]) {
    const { stdout } = await run(args);
    assert.match(stdout, /Usage:/);
    assert.match(stdout, /same as weft ui/);
    assert.doesNotMatch(stdout, /TEST_CONTROL_CENTER_OPENED/);
  }
  const { stdout } = await run(["ui", "status"]);
  assert.match(stdout, /Control Center is not running/);
  assert.doesNotMatch(stdout, /TEST_CONTROL_CENTER_OPENED/);
  const browser = await run(["ui", "--browser"]);
  assert.match(browser.stdout, /TEST_CONTROL_CENTER_OPENED browser=true/);
});

test("logging CLI commands persist the device switch without changing other configuration or history", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "weft-cli-logging-"));
  const configPath = path.join(home, "weft.config.json");
  const historyPath = path.join(home, "session.log");
  writeFileSync(configPath, JSON.stringify({ deviceName: "kept-device", custom: { retained: true } }));
  writeFileSync(historyPath, "untouched history");
  const run = (...args) => promisify(execFile)(process.execPath, [cliPath, ...args],
    { env: { ...process.env, WEFT_HOME: home }, timeout: 20_000, windowsHide: true });
  try {
    assert.match((await run("show-logging")).stdout, /logging: on/);
    await run("set-logging", "off");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.diagnostics.enabled, false);
    assert.equal(config.deviceName, "kept-device");
    assert.deepEqual(config.custom, { retained: true });
    assert.match((await run("show-logging")).stdout, /logging: off/);
    assert.match((await run("logs")).stdout, /Local diagnostics: off/);
    await assert.rejects(run("set-logging", "invalid"), /Usage: weft set-logging/);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).diagnostics.enabled, false);
    await run("set-logging", "on");
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).diagnostics.enabled, true);
    assert.equal(readFileSync(historyPath, "utf8"), "untouched history");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
