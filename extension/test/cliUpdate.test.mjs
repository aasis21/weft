// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveVersion } from "../src/version.mjs";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(testDir, "..", "bin", "weft.mjs");
const currentVersion = resolveVersion();

function adjacentVersion(direction) {
  const [major, minor, patch] = currentVersion
    .split("-", 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  if (direction > 0) return `${major}.${minor}.${patch + 1}`;
  if (patch > 0) return `${major}.${minor}.${patch - 1}`;
  if (minor > 0) return `${major}.${minor - 1}.999`;
  return `${Math.max(0, major - 1)}.999.999`;
}

async function runUpdateCheck(hostedVersion) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (req.url !== "/release-manifest.json") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ schemaVersion: 1, version: hostedVersion, files: {} }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));

  const root = mkdtempSync(join(tmpdir(), "weft-update-check-"));
  const installDir = join(root, "extension");
  const skillDir = join(root, "skill");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const result = await execFileAsync(process.execPath, [cliPath, "update", "--check"], {
      env: {
        ...process.env,
        NO_COLOR: "1",
        WEFT_HOME: join(root, "home"),
        WEFT_INSTALL_BASE: `http://127.0.0.1:${address.port}`,
        WEFT_INSTALL_DIR: installDir,
        WEFT_SKILL_DIR: skillDir,
      },
      timeout: 10_000,
    });

    assert.deepEqual(requests, ["/release-manifest.json"]);
    assert.equal(existsSync(installDir), false, "--check must not place or download bundles");
    assert.equal(existsSync(skillDir), false, "--check must not install the Copilot skill");
    return result.stdout;
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    rmSync(root, { recursive: true, force: true });
  }
}

test("weft update --check reports an up-to-date local build without installing", async () => {
  const stdout = await runUpdateCheck(currentVersion);

  assert.match(stdout, new RegExp(`Up to date\\. Weft ${currentVersion.replaceAll(".", "\\.")} is the current hosted release\\.`));
});

test("weft update --check reports an available hosted update without installing", async () => {
  const hostedVersion = adjacentVersion(1);
  const stdout = await runUpdateCheck(hostedVersion);

  assert.match(stdout, new RegExp(`Update available: ${currentVersion.replaceAll(".", "\\.")} → ${hostedVersion.replaceAll(".", "\\.")}`));
  assert.match(stdout, /Run `weft update`, then restart Copilot CLI \/ the Device Station\./);
});

test("weft update --check reports a newer local development build without installing", async () => {
  const hostedVersion = adjacentVersion(-1);
  const stdout = await runUpdateCheck(hostedVersion);

  assert.match(
    stdout,
    new RegExp(
      `Development build: local Weft ${currentVersion.replaceAll(".", "\\.")} is newer than hosted ${hostedVersion.replaceAll(".", "\\.")}\\.`,
    ),
  );
});

test("weft update keeps the complete prior bundle set when a staged download fails integrity", async () => {
  const bundleNames = ["extension.mjs", "relayServerProcess.mjs", "devtunnelHostWatchdog.mjs", "weft.mjs"];
  const payloads = Object.fromEntries(bundleNames.map((name) => [name, `new:${name}`]));
  const files = Object.fromEntries(
    bundleNames.map((name) => [
      name,
      {
        sha256: createHash("sha256")
          .update(name === "relayServerProcess.mjs" ? "different bytes" : payloads[name])
          .digest("hex"),
      },
    ]),
  );
  files["weft-skill.md"] = {
    sha256: createHash("sha256").update("new skill").digest("hex"),
  };
  const server = createServer((req, res) => {
    if (req.url === "/release-manifest.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schemaVersion: 1, version: currentVersion, files }));
      return;
    }
    const name = req.url?.slice(1);
    if (name && payloads[name]) {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(payloads[name]);
      return;
    }
    if (req.url === "/weft-skill.md") {
      res.writeHead(200, { "content-type": "text/markdown" });
      res.end("new skill");
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const root = mkdtempSync(join(tmpdir(), "weft-update-rollback-"));
  const installDir = join(root, "extension");
  const skillDir = join(root, "skill");
  mkdirSync(installDir, { recursive: true });
  for (const name of bundleNames) writeFileSync(join(installDir, name), `old:${name}`);
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, "update"], {
        env: {
          ...process.env,
          NO_COLOR: "1",
          WEFT_HOME: join(root, "home"),
          WEFT_INSTALL_BASE: `http://127.0.0.1:${address.port}`,
          WEFT_INSTALL_DIR: installDir,
          WEFT_SKILL_DIR: skillDir,
        },
        timeout: 10_000,
      }),
      /Integrity check failed/,
    );
    for (const name of bundleNames) {
      assert.equal(readFileSync(join(installDir, name), "utf8"), `old:${name}`);
    }
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
    rmSync(root, { recursive: true, force: true });
  }
});
