// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeLifecycleClient,
  discoverRuntimeLifecycles,
  startRuntimeLifecycleHost,
} from "../src/runtimeLifecycle.mjs";

test("the lifecycle facade publishes, proves, commands, updates, and removes one runtime", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-runtime-lifecycle-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const host = await startRuntimeLifecycleHost({
    storeAuthority: "sha256:store",
    sessionId: "session-a",
    processStartedAt: 100,
    handlers: {
      status: async () => ({ state: host.presence.state }),
    },
  }, {
    baseDir,
    identityOptions: { scope: {} },
    presenceOptions: {
      capability: "private-capability",
      now: () => 200,
    },
  });
  t.after(() => host.close());

  const discovery = await discoverRuntimeLifecycles({
    baseDir,
    storeAuthority: "sha256:store",
    sessionId: "session-a",
    verify: async () => ({ live: true }),
  });
  assert.equal(discovery.status, "single");
  const client = createRuntimeLifecycleClient(discovery.runtimes[0], { baseDir });
  assert.deepEqual((await client.command("status")).result, { state: "dormant" });
  host.updatePresence({ state: "active" });
  assert.deepEqual((await client.command("status")).result, { state: "active" });

  await host.close();
  const afterClose = await discoverRuntimeLifecycles({
    baseDir,
    storeAuthority: "sha256:store",
    sessionId: "session-a",
    verify: async () => ({ live: true }),
  });
  assert.equal(afterClose.status, "none");
});
