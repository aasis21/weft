// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { addProject, listProjects, loadProjects, removeProject, setDefault } from "../src/projects.mjs";

let helmHome;
let workDir;

beforeEach(() => {
  helmHome = mkdtempSync(join(tmpdir(), "helm-home-"));
  workDir = mkdtempSync(join(tmpdir(), "helm-project-"));
});

afterEach(() => {
  rmSync(helmHome, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

test("add/list/remove projects using an injected HELM_HOME", () => {
  const nested = join(workDir, "app");
  mkdirSync(nested);
  const added = addProject("app", nested, { makeDefault: true, baseDir: helmHome });
  assert.deepEqual(added, { name: "app", path: resolve(nested), default: true });
  assert.deepEqual(listProjects({ baseDir: helmHome }), [added]);

  removeProject("app", { baseDir: helmHome });
  assert.deepEqual(loadProjects({ baseDir: helmHome }), { projects: [] });
});

test("addProject rejects a non-existent directory", () => {
  assert.throws(
    () => addProject("missing", join(workDir, "missing"), { baseDir: helmHome }),
    /not an existing directory/,
  );
});

test("dedupes by name and enforces a single default", () => {
  const one = join(workDir, "one");
  const two = join(workDir, "two");
  mkdirSync(one);
  mkdirSync(two);
  addProject("one", one, { makeDefault: true, baseDir: helmHome });
  addProject("two", two, { makeDefault: true, baseDir: helmHome });
  addProject("one", two, { baseDir: helmHome });

  const projects = listProjects({ baseDir: helmHome });
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
  addProject("one", one, { baseDir: helmHome });
  addProject("two", two, { baseDir: helmHome });
  setDefault("one", { baseDir: helmHome });
  assert.equal(listProjects({ baseDir: helmHome }).find((p) => p.name === "one").default, true);
  setDefault("two", { baseDir: helmHome });
  const projects = listProjects({ baseDir: helmHome });
  assert.equal(projects.find((p) => p.name === "one").default, undefined);
  assert.equal(projects.find((p) => p.name === "two").default, true);
});
