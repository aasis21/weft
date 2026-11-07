// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Script } from "node:vm";
import { renderControlCenterPage } from "../src/controlCenterPage.mjs";

const browserEnabled = process.env.WEFT_CONTROL_CENTER_BROWSER === "1";
const qr = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

function initialState() {
  return {
    version: "0.2.39", checkedAt: new Date().toISOString(), platform: "win32", deviceName: "Studio Laptop",
    station: { state: "running", paired: false, supported: true, pid: 101 },
    relay: { state: "stopped", baseUrl: null },
    projects: [{ name: "Workbench", path: "C:\\work\\bench", default: true }],
    settings: {
      transport: { kind: "supabase" }, deviceName: null, permissionMode: "default", pairingMode: "persistent",
      terminalEnabled: false, files: { enabled: false, roots: [], exclude: ["**/.env"] },
    },
    sessions: [
      { runtimeId: "runtime-1", sessionId: "session-1", state: "dormant", pid: 301, title: "Design system", cwd: "C:\\work\\bench", paired: false, connected: null, watchLevel: "quiet" },
      { runtimeId: "runtime-2", sessionId: "session-2", state: "active", pid: 302, title: "Release planning", cwd: "C:\\work\\release", paired: true, phoneName: "My phone", connected: false, watchLevel: "active" },
    ],
    warnings: [],
  };
}

test("Control Center is self-contained and its browser script parses", () => {
  const html = renderControlCenterPage();
  assert.match(html, /<title>Weft \| Control Center<\/title>/);
  for (const name of ["overview", "sessions", "projects", "settings", "pairing", "diagnostics"]) assert.match(html, new RegExp('id="panel-' + name + '"'));
  assert.doesNotMatch(html, /(?:src|href)\s*=\s*["']https?:/);
  assert.doesNotMatch(html, /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|console\./);
  assert.match(html, /textContent/);
  assert.match(html, /aria-labelledby="confirmation-title"/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  const source = html.match(/<script>([\s\S]+?)<\/script>/)?.[1];
  assert.ok(source);
  assert.doesNotThrow(() => new Script(source));
});

test("Control Center actual management browser journey persists projects and settings", { skip: !browserEnabled, timeout: 30000 }, async (t) => {
  const { chromium } = await import("playwright");
  const { expect } = await import("@playwright/test");
  const { createControlCenterHost } = await import("../src/controlCenter.mjs");
  const { createManagement } = await import("../src/management.mjs");
  const { mkdir, readFile, writeFile, rm } = await import("node:fs/promises");
  const { join, resolve, dirname } = await import("node:path");
  const { randomUUID } = await import("node:crypto");
  const directory = ".control-center-browser-" + randomUUID();
  const home = join(directory, "home");
  const firstWorkspace = resolve(directory, "workspace-one");
  const secondWorkspace = resolve(directory, "workspace-two");
  let app, browser, context;
  const errors = [];
  t.after(async () => {
    await context?.close();
    await browser?.close();
    if (app) assert.equal(await app.close(), true, "The real host has no unfinished operation");
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], "The integrated page has no uncaught browser errors");
  });
  await Promise.all([mkdir(home, { recursive: true }), mkdir(join(directory, "workspace-one"), { recursive: true }), mkdir(join(directory, "workspace-two"), { recursive: true })]);
  const originalConfig = {
    deviceName: "Synthetic Linux workstation",
    transport: { kind: "devtunnel" },
    launch: { defaultPermissionMode: "default", retainedSyntheticOption: "keep-launch" },
    pairing: { persistent: false, retainedSyntheticOption: "keep-pairing" },
    terminal: { enabled: false, retainedSyntheticOption: "keep-terminal" },
    files: { enabled: false, roots: [], exclude: ["**/.env"] },
    retainedSyntheticSection: { purpose: "verify-save-preservation" },
  };
  await writeFile(join(home, "weft.config.json"), JSON.stringify(originalConfig), "utf8");
  const management = createManagement({
    baseDir: home,
    platform: "linux",
    discover: async () => ({ status: "empty", runtimes: [] }),
  });
  app = await createControlCenterHost({ baseDir: home, management, publish: false });
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, colorScheme: "light", reducedMotion: "reduce" });
  const page = await context.newPage();
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    requests.push({ origin: url.origin, method: request.method(), path: url.pathname.startsWith("/open/") ? "/open/[bootstrap]" : url.pathname });
  });
  const go = (name) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name, exact: true }).click();
  const complete = (label) => expect(page.locator("#operation-title")).toHaveText(label + " · complete", { timeout: 10000 });
  const storedProjects = async () => JSON.parse(await readFile(join(home, "projects.json"), "utf8")).projects;
  await page.goto(app.url);
  await expect(page.locator("#freshness")).toHaveText("Live · every 5s");
  assert.equal(page.url(), app.origin + "/", "Bootstrap redirects to the authenticated default page");
  assert.ok((await context.cookies()).some((cookie) => cookie.name === "weft_control" && cookie.httpOnly && cookie.sameSite === "Strict"));
  await expect(page.locator("#device-chip")).toHaveText(originalConfig.deviceName);
  await expect(page.locator("#station-start")).toBeDisabled();
  await expect(page.locator("#relay-start")).toBeDisabled();
  assert.equal((await management.state()).sessions.length, 0);

  await go("Projects");
  const maliciousName = '<img src=x onerror="window.__realLabelExecuted=1">';
  await page.locator("#project-name").fill(maliciousName);
  await page.locator("#project-path").fill(firstWorkspace);
  await page.locator("#project-default").check();
  await page.locator("#project-add").click();
  await complete("Adding project");
  assert.deepEqual(await storedProjects(), [{ name: maliciousName, path: firstWorkspace, default: true }]);
  await expect(page.locator("#projects-list h3")).toHaveText(maliciousName);
  assert.equal(await page.locator("#projects-list img").count(), 0);
  assert.equal(await page.evaluate(() => window.__realLabelExecuted), undefined);

  await page.locator("#project-name").fill("Integration workspace");
  await page.locator("#project-path").fill(secondWorkspace);
  await page.locator("#project-add").click();
  await complete("Adding project");
  assert.equal((await storedProjects())[0].default, true);
  const secondCard = page.locator("#projects-list article").filter({ has: page.getByRole("heading", { name: "Integration workspace", exact: true }) });
  await secondCard.getByRole("button", { name: "Make default", exact: true }).click();
  await complete("Changing default project");
  assert.deepEqual(await storedProjects(), [
    { name: maliciousName, path: firstWorkspace },
    { name: "Integration workspace", path: secondWorkspace, default: true },
  ]);
  await expect(secondCard.getByText("Default", { exact: true })).toBeVisible();
  assert.equal((await management.projects()).filter((project) => project.default).length, 1);

  await go("Settings");
  await expect(page.locator("#device-name")).toHaveValue(originalConfig.deviceName);
  await expect(page.locator("#transport")).toHaveValue("devtunnel");
  await expect(page.locator("#pairing-mode")).toHaveValue("ephemeral");
  await expect(page.locator("#terminal-enabled")).not.toBeChecked();
  const deviceName = "Synthetic Linux workstation revised";
  await page.locator("#device-name").fill(deviceName);
  await page.locator("#permission-mode").selectOption("allow-all");
  await page.locator("#files-enabled").check();
  await page.locator("#root-add").click();
  await page.locator('[data-root-field="name"]').fill("Synthetic preview");
  await page.locator('[data-root-field="path"]').fill(secondWorkspace);
  await page.locator("#file-excludes").fill("**/.env\n**/private/**");
  await page.locator("#settings-save").click();
  await expect(page.getByRole("dialog")).toContainText("broadens tool permissions");
  await page.locator("#confirmation-accept").click();
  await complete("Saving settings");
  const files = { enabled: true, roots: [{ name: "Synthetic preview", path: secondWorkspace }], exclude: ["**/.env", "**/private/**"] };
  assert.deepEqual(JSON.parse(await readFile(join(home, "weft.config.json"), "utf8")), {
    ...originalConfig,
    deviceName,
    launch: { ...originalConfig.launch, defaultPermissionMode: "allow-all" },
    files,
  });
  assert.deepEqual(management.settings(), {
    transport: { kind: "devtunnel" }, deviceName, permissionMode: "allow-all",
    pairingMode: "ephemeral", terminalEnabled: false, files,
  });
  await expect(page.locator("#settings-dirty")).toBeHidden();
  await expect(page.locator("#settings-save")).toBeDisabled();
  await expect(page.locator("#terminal-enabled")).not.toBeChecked();
  await expect(page.locator("#pairing-mode")).toHaveValue("ephemeral");
  assert.equal(await page.evaluate(() => window.__realLabelExecuted), undefined);
  const hydratedRevision = (await management.state()).settingsRevision;
  assert.match(hydratedRevision, /^[a-f0-9]{64}$/);
  await page.locator("#device-name").fill("Synthetic unsaved local draft");
  await management.execute("settings.save", { deviceName: "Synthetic CLI revised" }, { trustedCli: true });
  const cliRevision = (await management.state()).settingsRevision;
  assert.notEqual(cliRevision, hydratedRevision);
  await page.locator("#refresh").click();
  await expect(page.locator("#device-chip")).toHaveText("Synthetic CLI revised");
  await expect(page.locator("#device-name")).toHaveValue("Synthetic unsaved local draft");
  await page.locator("#settings-save").click();
  await expect(page.locator("#operation-title")).toHaveText("Saving settings · failed");
  await expect(page.locator("#operation-detail")).toContainText("changed");
  assert.equal(management.settings().deviceName, "Synthetic CLI revised", "A stale full form cannot overwrite the CLI change");
  await expect(page.locator("#device-name")).toHaveValue("Synthetic unsaved local draft");
  await expect(page.locator("#settings-dirty")).toBeVisible();
  await page.locator("#settings-reset").click();
  await expect(page.getByRole("dialog")).toContainText("Discard unsaved settings");
  await page.locator("#confirmation-accept").click();
  await expect(page.locator("#device-name")).toHaveValue("Synthetic CLI revised");
  await expect(page.locator("#settings-dirty")).toBeHidden();
  await page.locator("#device-name").fill(deviceName);
  await page.locator("#settings-save").click();
  await complete("Saving settings");
  assert.equal(management.settings().deviceName, deviceName);
  assert.deepEqual(JSON.parse(await readFile(join(home, "weft.config.json"), "utf8")), {
    ...originalConfig, deviceName, launch: { ...originalConfig.launch, defaultPermissionMode: "allow-all" }, files,
  });
  assert.ok(requests.some((request) => request.path === "/open/[bootstrap]"));
  assert.equal(requests.filter((request) => request.path === "/api/operations" && request.method === "POST").length, 6);
  assert.ok(requests.some((request) => request.path.startsWith("/api/operations/")));
  assert.ok(requests.every((request) => request.origin === app.origin), "The real journey never contacts an external origin");
  assert.ok(requests.every((request) => !["/api/pairing", "/api/update"].includes(request.path)), "No pairing or release/network check is requested");

  if (process.env.WEFT_CONTROL_CENTER_SCREENSHOT) {
    await go("Overview");
    await page.locator("#operation-dismiss").click();
    await expect(page.locator("#device-chip")).toHaveText(deviceName);
    await expect(page.locator("#metric-projects")).toHaveText("2");
    await expect(page.locator("#pairing-code")).toHaveValue("");
    assert.equal(await page.locator("#pairing-qr").getAttribute("src"), null);
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await mkdir(dirname(process.env.WEFT_CONTROL_CENTER_SCREENSHOT), { recursive: true });
    await page.screenshot({ path: process.env.WEFT_CONTROL_CENTER_SCREENSHOT, fullPage: true });
  }
});

// The extension's normal Node suite does not require a downloaded browser.
// Run from the repository root: $env:WEFT_CONTROL_CENTER_BROWSER='1'; node --test extension\test\controlCenterPage.test.mjs
test("Control Center rendered browser behavior", { skip: !browserEnabled, timeout: 120000 }, async (t) => {
  const { chromium } = await import("playwright");
  const { expect } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());

  async function harness(subtest, configure = () => {}, viewport = { width: 1440, height: 1000 }) {
    const h = {
      state: initialState(), calls: [], requests: [], operations: new Map(),
      stateStatus: 200, stateDelay: 0, runningPolls: 1, pollFailures: 0, failure: null, postStatus: 202,
      pairing: { state: "pairing-ready", paired: false, phoneName: null, code: "private-fixture-pairing-code", qr },
      startResult: { runtimeId: "new-runtime", state: "pairing-ready", paired: false, code: "new-session-private-code", qr },
    };
    configure(h);
    const timers = new Set();
    function applyOperation(operation) {
      if (operation.applied) return;
      operation.applied = true;
      const { action, payload } = operation;
      if (action === "project.add") {
        if (payload.makeDefault) h.state.projects.forEach((project) => { project.default = false; });
        h.state.projects.push({ name: payload.name, path: payload.path, default: payload.makeDefault });
      } else if (action === "project.default") h.state.projects.forEach((project) => { project.default = project.name === payload.name; });
      else if (action === "project.remove") h.state.projects = h.state.projects.filter((project) => project.name !== payload.name);
      else if (action === "settings.save") {
        const { confirmed: _confirmed, expectedRevision: _expectedRevision, ...settings } = payload;
        h.state.settings = settings;
        h.state.deviceName = payload.deviceName;
      } else if (action.startsWith("station.") || action.startsWith("relay.")) {
        const [kind, verb] = action.split(".");
        h.state[kind].state = verb === "stop" ? "stopped" : "running";
      } else if (action === "session.activate") h.state.sessions.find((session) => session.runtimeId === payload.runtimeId).state = "active";
      else if (action === "session.disconnect") {
        const session = h.state.sessions.find((item) => item.runtimeId === payload.runtimeId);
        session.connected = false; session.paired = false;
      } else if (action === "session.start") {
        h.state.sessions.push({ runtimeId: "new-runtime", sessionId: "new-session", state: "active", title: payload.name || "New session", connected: null, paired: false });
      }
      h.state.checkedAt = new Date().toISOString();
    }
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, "http://127.0.0.1");
      h.requests.push({ path: url.pathname, search: url.search, method: request.method });
      const json = (status, body) => {
        if (response.destroyed) return;
        response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify(body));
      };
      try {
        if (url.pathname === "/") {
          response.writeHead(200, {
            "Content-Type": "text/html",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'",
          });
          response.end(renderControlCenterPage());
        } else if (url.pathname === "/api/state") {
          if (h.stateDelay) await new Promise((resolve) => {
            const timer = setTimeout(() => { timers.delete(timer); resolve(); }, h.stateDelay);
            timers.add(timer);
          });
          json(h.stateStatus, h.stateStatus === 200 ? h.state : { error: { code: "unavailable", message: "Local status unavailable" } });
        } else if (url.pathname === "/api/pairing") json(200, h.pairing);
        else if (url.pathname === "/api/update") json(200, { current: "0.2.39", available: true, latest: "0.2.40", message: "Published release available." });
        else if (url.pathname === "/api/operations" && request.method === "POST") {
          let body = "";
          for await (const chunk of request) body += chunk;
          const input = JSON.parse(body);
          h.calls.push(input);
          h.operations.set(input.id, { ...input, polls: 0, error: h.failure });
          json(h.postStatus, h.postStatus === 202 ? { id: input.id, state: "running" } : { error: { message: "Local response unavailable; request may be accepted" } });
        } else if (url.pathname.startsWith("/api/operations/")) {
          if (h.pollFailures > 0) { h.pollFailures--; json(503, { error: { message: "Temporary local status loss" } }); return; }
          const id = decodeURIComponent(url.pathname.slice("/api/operations/".length));
          const operation = h.operations.get(id);
          if (!operation) { json(404, { error: { code: "not-found", message: "Operation not found" } }); return; }
          operation.polls++;
          const running = operation.polls <= h.runningPolls;
          if (!running && !operation.error) applyOperation(operation);
          json(200, {
            id, state: running ? "running" : operation.error ? "failed" : "succeeded",
            ...(operation.error && !running ? { error: operation.error } : {}),
            ...(!running && operation.action === "session.start" ? { result: h.startResult } : {}),
          });
        } else json(404, { error: { code: "not-found", message: "Not found" } });
      } catch { json(500, { error: { code: "fixture-failure", message: "Fixture request failed" } }); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const context = await browser.newContext({ viewport, colorScheme: "light" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    subtest.after(async () => {
      await context.close();
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      assert.deepEqual(errors, [], "No uncaught browser exceptions");
    });
    h.page = page;
    h.context = context;
    h.origin = "http://127.0.0.1:" + server.address().port;
    h.go = async (tab) => page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: tab, exact: true }).click();
    h.ready = async () => { await page.goto(h.origin); await expect(page.locator("#freshness")).toHaveText("Live · every 5s"); };
    h.finished = async () => expect(page.locator("#operation-title")).toContainText("· complete", { timeout: 10000 });
    await h.ready();
    return h;
  }

  await t.test("status is passive, nullable links remain unknown, and pairing is fetched only on demand", async (st) => {
    const h = await harness(st);
    await expect(h.page.locator("#metric-connected")).toHaveText("Unknown");
    await expect(h.page.locator("#station-phone")).toHaveText("No phone paired");
    assert.equal(h.calls.length, 0);
    assert.equal(h.requests.filter((request) => request.path === "/api/pairing").length, 0);
    await h.go("Sessions");
    await expect(h.page.locator("#sessions-list")).toContainText("Phone connection unknown");
    await expect(h.page.locator("#sessions-list")).toContainText("Phone trusted · not connected");
    assert.equal(h.requests.filter((request) => request.path === "/api/pairing").length, 0);
    await h.page.getByRole("button", { name: "Show pairing" }).first().click();
    await expect(h.page.locator("#pairing-qr")).toBeVisible();
    assert.equal(h.requests.find((request) => request.path === "/api/pairing").search, "?runtimeId=runtime-1");
    await h.go("Overview");
    assert.equal(await h.page.locator("#pairing-code").inputValue(), "");
    assert.equal(await h.page.locator("#pairing-qr").getAttribute("src"), null);
    assert.equal(h.calls.length, 0);
  });

  await t.test("untrusted labels and error messages never become markup or executable SVG", async (st) => {
    const malicious = '<img src=x onerror="window.__labelExecuted=1"><script>window.__labelExecuted=2</script>';
    const h = await harness(st, (h) => {
      h.state.deviceName = malicious;
      h.state.projects[0].name = malicious;
      h.state.sessions[0].title = malicious;
      h.state.warnings = ["token=do-not-display https://secret.invalid/grant"];
      h.pairing.qr = "data:image/svg+xml,<svg onload='window.__labelExecuted=3'/>";
    });
    await expect(h.page.locator("#device-chip")).toHaveText(malicious);
    await h.go("Projects");
    await expect(h.page.locator("#projects-list h3")).toHaveText(malicious);
    assert.equal(await h.page.locator("#projects-list img, #projects-list script").count(), 0);
    await h.go("Sessions");
    await expect(h.page.locator("#sessions-list h3").first()).toHaveText(malicious);
    await h.go("Pairing");
    await expect(h.page.locator("#pairing-code-details")).toBeVisible();
    await expect(h.page.locator("#pairing-qr")).toBeHidden();
    assert.equal(await h.page.evaluate(() => window.__labelExecuted), undefined);
    await h.go("Diagnostics");
    await expect(h.page.locator("#diagnostic-warning-list")).toContainText("[redacted]");
    await expect(h.page.locator("#diagnostic-warning-list")).not.toContainText("do-not-display");
  });

  await t.test("project form submits a real operation and clears only the saved draft", async (st) => {
    const h = await harness(st);
    await h.go("Projects");
    await h.page.getByLabel("Project name", { exact: true }).fill("New workspace");
    await h.page.getByLabel("Folder path", { exact: true }).fill("C:\\work\\new");
    await h.page.getByLabel("Make this the default project").check();
    await h.page.getByRole("button", { name: "Add project", exact: true }).click();
    await expect(h.page.locator("#project-add")).toBeDisabled();
    await h.finished();
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(h.calls[0].payload, { name: "New workspace", path: "C:\\work\\new", makeDefault: true });
    await expect(h.page.locator("#projects-list")).toContainText("New workspace");
    assert.equal(await h.page.locator("#project-name").inputValue(), "");
    assert.ok(h.requests.some((request) => request.path === "/api/operations/" + h.calls[0].id));
  });

  await t.test("operation failure is sanitized and preserves the project draft", async (st) => {
    const h = await harness(st, (h) => { h.failure = { code: "invalid-path", message: "Folder not found. token=private-secret <img onerror=alert(1)>" }; });
    await h.go("Projects");
    await h.page.locator("#project-name").fill("Keep my edits");
    await h.page.locator("#project-path").fill("C:\\missing");
    await h.page.locator("#project-add").click();
    await expect(h.page.locator("#operation-title")).toContainText("· failed");
    await expect(h.page.locator("#operation-detail")).toContainText("Folder not found");
    await expect(h.page.locator("#operation-detail")).not.toContainText("private-secret");
    assert.equal(await h.page.locator("#operation-detail img").count(), 0);
    assert.equal(await h.page.locator("#project-name").inputValue(), "Keep my edits");
    await expect(h.page.locator("#project-add")).toBeEnabled();
  });

  await t.test("visible-only five-second polling preserves project and settings edits and restores on foreground", async (st) => {
    const h = await harness(st);
    await h.page.clock.install();
    await h.go("Projects");
    await h.page.locator("#project-name").fill("Unsubmitted project");
    await h.page.locator("#project-path").fill("C:\\draft");
    await h.go("Settings");
    await expect(h.page.locator("#device-name")).toHaveValue("Studio Laptop");
    await h.page.locator("#device-name").fill("Unsaved device name");
    await h.page.locator("#root-add").click();
    await h.page.locator('[data-root-field="name"]').fill("Draft root");
    await h.page.locator('[data-root-field="path"]').fill("C:\\draft-root");
    h.state.settings.deviceName = "Externally changed";
    h.state.projects.push({ name: "Another project", path: "C:\\another", default: false });
    const requests = () => h.requests.filter((request) => request.path === "/api/state").length;
    const before = requests();
    await h.page.clock.fastForward(5000);
    await expect.poll(requests).toBeGreaterThan(before);
    await expect(h.page.locator("#device-name")).toHaveValue("Unsaved device name");
    await expect(h.page.locator('[data-root-field="name"]')).toHaveValue("Draft root");
    await h.page.evaluate(() => {
      window.__hidden = true;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => window.__hidden });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const hiddenCount = requests();
    await h.page.clock.fastForward(15000);
    assert.equal(requests(), hiddenCount);
    await h.page.evaluate(() => { window.__hidden = false; document.dispatchEvent(new Event("visibilitychange")); });
    await expect.poll(requests).toBeGreaterThan(hiddenCount);
    await h.go("Projects");
    await expect(h.page.locator("#project-name")).toHaveValue("Unsubmitted project");
    await expect(h.page.locator("#project-path")).toHaveValue("C:\\draft");
    assert.equal(h.calls.length, 0);
  });

  await t.test("worker stop requires keyboard-accessible confirmation, Escape cancels, Copilot is preserved", async (st) => {
    const h = await harness(st);
    await h.page.locator("#station-stop").click();
    const dialog = h.page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Station utilities on the phone will close");
    await expect(dialog).toContainText("Copilot processes and sessions are preserved");
    await expect(h.page.locator("#confirmation-cancel")).toBeFocused();
    await h.page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    assert.equal(h.calls.length, 0);
    await expect(h.page.locator("#station-stop")).toBeFocused();
    await h.page.locator("#station-stop").click();
    await dialog.getByRole("button", { name: "Stop Station", exact: true }).click();
    await h.finished();
    assert.equal(h.calls[0].action, "station.stop");
    assert.deepEqual(h.calls[0].payload, { confirmed: true });
    assert.equal(h.state.sessions.length, 2);
    await expect(h.page.locator("#station-status")).toHaveText("Stopped");
    await expect(h.page.locator("#station-start")).toBeEnabled();
  });

  await t.test("trust rotation and relay stop have distinct explicit warnings", async (st) => {
    const h = await harness(st, (h) => { h.state.relay.state = "running"; });
    await h.page.locator("#relay-stop").click();
    await expect(h.page.getByRole("dialog")).toContainText("Phone connections using this relay will be interrupted");
    await h.page.locator("#confirmation-cancel").click();
    await h.go("Pairing");
    await h.page.locator("#pairing-replace").click();
    await expect(h.page.getByRole("dialog")).toContainText("rotates pairing trust");
    await expect(h.page.getByRole("dialog")).toContainText("Do not use this to repair a temporary connection drop");
    await h.page.locator("#confirmation-accept").click();
    await h.finished();
    assert.deepEqual(h.calls.map(({ action, payload }) => ({ action, payload })), [{ action: "pairing.replace", payload: { confirmed: true } }]);
  });

  await t.test("sensitive settings are confirmed and submitted with named roots and exclusions", async (st) => {
    const h = await harness(st);
    await h.go("Settings");
    await h.page.locator("#files-enabled").check();
    await h.page.locator("#root-add").click();
    await h.page.locator('[data-root-field="name"]').fill("Source");
    await h.page.locator('[data-root-field="path"]').fill("C:\\source");
    await h.page.locator("#file-excludes").fill("**/.env\n**/secrets/**");
    await h.page.locator("#permission-mode").selectOption("allow-all");
    await h.page.locator("#settings-save").click();
    await expect(h.page.getByRole("dialog")).toContainText("broadens tool permissions");
    await expect(h.page.getByRole("dialog")).toContainText("File-sharing access");
    assert.equal(h.calls.length, 0);
    await h.page.locator("#confirmation-accept").click();
    await h.finished();
    assert.equal(h.calls[0].action, "settings.save");
    assert.equal(h.calls[0].payload.confirmed, true);
    assert.equal(h.calls[0].payload.deviceName, "Studio Laptop");
    assert.equal(Object.hasOwn(h.calls[0].payload, "expectedRevision"), false, "Older state fixtures omit revision preconditions");
    assert.deepEqual(h.calls[0].payload.files, { enabled: true, roots: [{ name: "Source", path: "C:\\source" }], exclude: ["**/.env", "**/secrets/**"] });
    await expect(h.page.locator("#settings-dirty")).toBeHidden();
    await expect(h.page.locator("#settings-save")).toBeDisabled();
  });

  await t.test("operations keep polling when hidden or switched and retry the same ID after connection loss", async (st) => {
    const h = await harness(st, (h) => { h.pollFailures = 1; h.runningPolls = 0; });
    await h.go("Projects");
    await h.page.locator("#project-name").fill("Background operation");
    await h.page.locator("#project-path").fill("C:\\background");
    await h.page.locator("#project-add").click();
    await h.go("Diagnostics");
    await h.page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); });
    await expect(h.page.locator("#operation-detail")).toContainText("outcome is still unknown");
    await expect(h.page.locator("#operation-retry")).toBeVisible();
    await h.page.locator("#operation-retry").click();
    await h.finished();
    assert.equal(h.calls.length, 1);
    assert.equal(h.state.projects.at(-1).name, "Background operation");
  });

  await t.test("a lost POST response recovers the accepted operation without dispatching twice", async (st) => {
    const h = await harness(st, (h) => { h.postStatus = 503; h.runningPolls = 0; });
    await h.go("Projects");
    await h.page.locator("#project-name").fill("Accepted once");
    await h.page.locator("#project-path").fill("C:\\once");
    await h.page.locator("#project-add").click();
    await expect(h.page.locator("#operation-detail")).toContainText("may have been accepted");
    await h.finished();
    assert.equal(h.calls.length, 1);
    assert.equal(h.state.projects.filter((project) => project.name === "Accepted once").length, 1);
  });

  await t.test("edits made during a successful save are not overwritten by the saved response", async (st) => {
    const h = await harness(st, (h) => { h.runningPolls = 2; });
    await h.go("Settings");
    await h.page.locator("#device-name").fill("Saved name");
    await h.page.locator("#settings-save").click();
    await expect(h.page.locator("#settings-save")).toBeDisabled();
    await h.page.locator("#device-name").fill("A newer unsaved name");
    await h.finished();
    assert.equal(h.calls[0].payload.deviceName, "Saved name");
    assert.equal(h.state.settings.deviceName, "Saved name");
    await expect(h.page.locator("#device-name")).toHaveValue("A newer unsaved name");
    await expect(h.page.locator("#settings-dirty")).toBeVisible();
    await expect(h.page.locator("#settings-save")).toBeEnabled();
  });

  await t.test("settings revision stays with the hydrated draft until conflict is intentionally discarded", async (st) => {
    const originalRevision = "a".repeat(64);
    const newerRevision = "b".repeat(64);
    const h = await harness(st, (h) => { h.state.settingsRevision = originalRevision; });
    await h.page.clock.install();
    await h.go("Settings");
    await h.page.locator("#device-name").fill("My unsaved revision");
    h.state.settings.deviceName = "Saved by CLI";
    h.state.deviceName = "Saved by CLI";
    h.state.settingsRevision = newerRevision;
    await h.page.clock.fastForward(5000);
    await expect(h.page.locator("#device-chip")).toHaveText("Saved by CLI");
    await expect(h.page.locator("#device-name")).toHaveValue("My unsaved revision");
    h.failure = { code: "settings-conflict", message: "Settings changed since this form was loaded. Reload or discard edits intentionally before saving." };
    await h.page.locator("#settings-save").click();
    await expect(h.page.locator("#operation-title")).toHaveText("Saving settings · failed");
    assert.equal(h.calls[0].payload.expectedRevision, originalRevision);
    await expect(h.page.locator("#operation-detail")).toContainText("Settings changed");
    await expect(h.page.locator("#device-name")).toHaveValue("My unsaved revision");
    await expect(h.page.locator("#settings-dirty")).toBeVisible();
    assert.equal(h.state.settings.deviceName, "Saved by CLI");
    await h.page.locator("#settings-reset").click();
    await expect(h.page.getByRole("dialog")).toContainText("Discard unsaved settings");
    await expect(h.page.locator("#device-name")).toHaveValue("My unsaved revision");
    await h.page.locator("#confirmation-accept").click();
    await expect(h.page.locator("#device-name")).toHaveValue("Saved by CLI");
    await expect(h.page.locator("#settings-dirty")).toBeHidden();
    h.failure = null;
    await h.page.locator("#device-name").fill("Reviewed newer settings");
    await h.page.locator("#settings-save").click();
    await h.finished();
    assert.equal(h.calls[1].payload.expectedRevision, newerRevision);
    assert.equal(h.state.settings.deviceName, "Reviewed newer settings");
  });

  await t.test("stale state cannot imply a live phone or allow mutation, and API timeouts recover", async (st) => {
    const h = await harness(st, (h) => { h.state.sessions[0].connected = true; h.state.sessions[0].state = "active"; });
    await h.page.clock.install();
    h.stateDelay = 20000;
    const before = h.requests.length;
    await h.page.locator("#refresh").click();
    await expect.poll(() => h.requests.length).toBeGreaterThan(before);
    await h.page.clock.fastForward(10001);
    await expect(h.page.locator("#connection-error")).toBeVisible();
    await expect(h.page.locator("#connection-message")).toContainText("10 seconds");
    await expect(h.page.locator("#station-stop")).toBeDisabled();
    await expect(h.page.locator("#metric-connected")).toHaveText("Unknown");
    await h.go("Sessions");
    await expect(h.page.locator("#sessions-list")).toContainText("Phone connection unknown");
    await expect(h.page.locator("#sessions-list")).not.toContainText("Phone connected");
    h.stateDelay = 0;
    await h.page.locator("#retry").click();
    await expect(h.page.locator("#freshness")).toHaveText("Live · every 5s");
    await expect(h.page.locator("#connection-error")).toBeHidden();
  });

  await t.test("unsupported platforms retain remedies and disable workload and launch controls", async (st) => {
    const h = await harness(st, (h) => { h.state.platform = "linux"; h.state.station.supported = false; });
    for (const id of ["station-start", "station-stop", "station-restart", "relay-start", "relay-stop", "relay-restart"]) await expect(h.page.locator("#" + id)).toBeDisabled();
    await expect(h.page.locator("#station-remedy")).toContainText("require Windows");
    await h.go("Sessions");
    await expect(h.page.locator("#session-start")).toBeDisabled();
    await expect(h.page.getByRole("button", { name: "Activate Weft" }).first()).toBeEnabled();
    assert.equal(h.calls.length, 0);
  });

  await t.test("explicit activation opens only that session's pairing and explicit launch shows returned QR", async (st) => {
    const h = await harness(st);
    await h.go("Sessions");
    await h.page.getByRole("button", { name: "Activate Weft" }).first().click();
    await h.finished();
    await expect(h.page.locator("#panel-pairing")).toBeVisible();
    await expect(h.page.locator("#pairing-target")).toHaveValue("runtime-1");
    assert.equal(h.calls[0].action, "session.activate");
    assert.ok(h.requests.some((request) => request.path === "/api/pairing" && request.search === "?runtimeId=runtime-1"));
    await h.go("Sessions");
    await h.page.locator("#session-name").fill("Ship the design");
    await h.page.locator("#session-start").click();
    await h.finished();
    await expect(h.page.locator("#panel-pairing")).toBeVisible();
    await expect(h.page.locator("#pairing-qr")).toBeVisible();
    await expect(h.page.locator("#pairing-code")).toHaveValue("new-session-private-code");
    assert.deepEqual(h.calls[1].payload, { projectName: "Workbench", mode: "default", name: "Ship the design" });
    assert.equal(h.calls[1].action, "session.start");
    assert.equal(h.calls.filter((call) => call.action === "session.start").length, 1);
  });

  await t.test("expired or already trusted pairing never exposes a grant", async (st) => {
    const h = await harness(st, (h) => { h.pairing.paired = true; h.pairing.phoneName = "Trusted phone"; });
    await h.go("Pairing");
    await expect(h.page.locator("#pairing-badge")).toHaveText("Phone trusted");
    await expect(h.page.locator("#pairing-qr")).toBeHidden();
    await expect(h.page.locator("#pairing-code")).toHaveValue("");
    h.pairing.paired = false; h.pairing.expiresAt = 1;
    await h.page.locator("#pairing-refresh").click();
    await expect(h.page.locator("#pairing-message")).toContainText("expired");
    await expect(h.page.locator("#pairing-qr")).toBeHidden();
    await expect(h.page.locator("#pairing-code")).toHaveValue("");
    await expect(h.page.locator("#pairing-refresh")).toBeEnabled();
    h.pairing.state = "unknown"; h.pairing.expiresAt = null;
    await h.page.locator("#pairing-refresh").click();
    await expect(h.page.locator("#pairing-badge")).toHaveText("Pairing status unknown");
    await expect(h.page.locator("#pairing-code")).toHaveValue("");
    await expect(h.page.locator("#pairing-refresh")).toBeEnabled();
  });

  await t.test("launch uses confirmed broader permissions and consumes the backend's pairing-only result", async (st) => {
    const h = await harness(st, (h) => { h.startResult = { state: "pairing-ready", message: "Ready to pair", code: "explicit-start-code", qr }; });
    await h.go("Sessions");
    await h.page.locator("#session-mode").selectOption("allow-all");
    await h.page.locator("#session-start").click();
    await expect(h.page.getByRole("dialog")).toContainText("broadens tool permissions");
    assert.equal(h.calls.length, 0);
    await h.page.locator("#confirmation-accept").click();
    await h.finished();
    assert.deepEqual(h.calls[0].payload, { projectName: "Workbench", mode: "allow-all", confirmed: true });
    await expect(h.page.locator("#pairing-target")).toHaveValue("__launched");
    await expect(h.page.locator("#pairing-code")).toHaveValue("explicit-start-code");
    assert.equal(h.requests.filter((request) => request.path === "/api/pairing").length, 0);
    await h.page.locator("#pairing-refresh").click();
    await expect(h.page.locator("#pairing-message")).toContainText("did not include a runtime ID");
    await expect(h.page.locator("#pairing-code")).toHaveValue("");
    assert.equal(h.requests.filter((request) => request.path === "/api/pairing").length, 0);
  });

  await t.test("diagnostics checks published availability but never installs or deploys", async (st) => {
    const h = await harness(st);
    await h.go("Diagnostics");
    await expect(h.page.locator("#diagnostic-version")).toHaveText("0.2.39");
    await h.page.locator("#update-check").click();
    await expect(h.page.locator("#update-result")).toContainText("Update available: 0.2.40");
    await expect(h.page.locator("#update-result")).toContainText("Nothing has been installed");
    assert.equal(h.calls.length, 0);
    assert.equal(h.requests.filter((request) => request.path === "/api/update").length, 1);
  });

  await t.test("desktop, narrow phone, and dark layouts remain accessible without page overflow", async (st) => {
    const h = await harness(st);
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    for (const tab of ["Overview", "Sessions", "Projects", "Settings", "Pairing", "Diagnostics"]) {
      await h.go(tab);
      const results = await new AxeBuilder({ page: h.page }).analyze();
      assert.deepEqual(results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => node.target) })), [], tab + " accessibility");
    }
    for (const width of [1440, 768, 390, 320]) {
      await h.page.setViewportSize({ width, height: 900 });
      for (const tab of ["Overview", "Sessions", "Projects", "Settings", "Pairing", "Diagnostics"]) {
        await h.go(tab);
        const overflow = await h.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(overflow, false, tab + " has no page overflow at " + width);
        await expect(h.page.locator("#page-title")).toBeVisible();
      }
    }
    await h.page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await h.go("Overview");
    assert.equal(await h.page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(32, 33, 43)");
    const darkResults = await new AxeBuilder({ page: h.page }).analyze();
    assert.deepEqual(darkResults.violations.map((violation) => violation.id), []);
  });
});
