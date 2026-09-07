// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseStartOptions } from "../src/startOptions.mjs";

const execFileAsync = promisify(execFile);
const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "weft.mjs");

test("start options default to reconnecting the saved phone", () => {
  assert.deepEqual(parseStartOptions(), { help: false, newDevice: false });
});

test("start options accept new-device and its rotate alias", () => {
  assert.deepEqual(parseStartOptions(["--new-device"]), { help: false, newDevice: true });
  assert.deepEqual(parseStartOptions(["--rotate-pairing"]), { help: false, newDevice: true });
});

test("start options support command-specific help and reject typos", () => {
  assert.deepEqual(parseStartOptions(["--help"]), { help: true, newDevice: false });
  assert.throws(() => parseStartOptions(["--new-devce"]), /weft start --help/);
});

test("weft start --help explains same-phone and new-phone recovery without starting", async () => {
  const home = mkdtempSync(join(tmpdir(), "weft-start-help-"));
  try {
    const result = await execFileAsync(process.execPath, [cliPath, "start", "--help"], {
      env: { ...process.env, NO_COLOR: "1", WEFT_HOME: home },
      timeout: 5_000,
    });
    assert.match(result.stdout, /weft start --new-device/);
    assert.match(result.stdout, /different phone/);
    assert.match(result.stdout, /valid QR repeatedly reports no laptop ACK/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
