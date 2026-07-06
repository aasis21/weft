// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addProject, listProjects, loadProjects, removeProject, setDefault } from "../src/projects.mjs";

let weftHome;
let workDir;

beforeEach(() => {
  weftHome = mkdtempSync(join(tmpdir(), "weft-home-"));
  workDir = mkdtempSync(join(tmpdir(), "weft-project-"));
});

afterEach(() => {
  rmSync(weftHome, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

test("add/list/remove projects using an injected WEFT_HOME", () => {
  const nested = join(workDir, "app");
  mkdirSync(nested);
  const added = addProject("app", nested, { makeDefault: true, baseDir: weftHome });
  assert.deepEqual(added, { name: "app", path: resolve(nested), default: true });
  assert.deepEqual(listProjects({ baseDir: weftHome }), [added]);

  removeProject("app", { baseDir: weftHome });
  assert.deepEqual(loadProjects({ baseDir: weftHome }), { projects: [] });
});

test("addProject rejects a non-existent directory", () => {
  assert.throws(
    () => addProject("missing", join(workDir, "missing"), { baseDir: weftHome }),
    /not an existing directory/,
  );
});

test("dedupes by name and enforces a single default", () => {
  const one = join(workDir, "one");
  const two = join(workDir, "two");
  mkdirSync(one);
  mkdirSync(two);
  addProject("one", one, { makeDefault: true, baseDir: weftHome });
  addProject("two", two, { makeDefault: true, baseDir: weftHome });
  addProject("one", two, { baseDir: weftHome });

  const projects = listProjects({ baseDir: weftHome });
  assert.equal(projects.length, 2);
  assert.equal(projects.filter((p) => p.default).length, 1);
  assert.deepEqual(projects.find((p) => p.default), { name: "two", path: resolve(two), default: true });
  assert.equal(projects.find((p) => p.name === "one").path, resolve(two));
});

test("setDefault moves the default marker", () => {
  const one = join(workDir, "one");
  const two = join(workDir, "two");
  mkdirSync(one);
  mkdirSync(two);
  addProject("one", one, { baseDir: weftHome });
  addProject("two", two, { baseDir: weftHome });
  setDefault("one", { baseDir: weftHome });
  assert.equal(listProjects({ baseDir: weftHome }).find((p) => p.name === "one").default, true);
  setDefault("two", { baseDir: weftHome });
  const projects = listProjects({ baseDir: weftHome });
  assert.equal(projects.find((p) => p.name === "one").default, undefined);
  assert.equal(projects.find((p) => p.name === "two").default, true);
});
