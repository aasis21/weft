import test from "node:test";
import assert from "node:assert/strict";
import { validWorkspaceRequest, validWorkspaceResult, workspaceRequest, workspaceResult } from "../workspace.mjs";
test("workspace protocol accepts bounded requests and rejects unrelated or executable fields", () => {
  assert.equal(validWorkspaceRequest({ requestId: "r1", action: "list", path: "" }), true);
  for (const scope of ["workspace", "touched"]) assert.equal(validWorkspaceRequest({ requestId: "r1", action: "list", path: "", scope }), true);
  assert.equal(validWorkspaceRequest({ requestId: "r1", action: "list", path: "", scope: "all-files" }), false);
  assert.equal(validWorkspaceRequest({ requestId: "r1", action: "open", path: "file.html", command: "run" }), false);
  assert.equal(validWorkspaceRequest({ requestId: "r1", action: "page", previewId: "a", offset: -1 }), false);
  assert.equal(workspaceRequest({ requestId: "r1", action: "changes" }).eventSubtype, "workspace_request");
});
test("workspace results have explicit data or error and bounded content", () => {
  assert.equal(validWorkspaceResult(workspaceResult({ requestId: "r1", data: { action: "list", entries: [], cursor: null } }).msg), true);
  assert.equal(validWorkspaceResult({ requestId: "r1", data: { action: "page", text: "x".repeat(9000), offset: 0, nextOffset: null } }), false);
  assert.equal(validWorkspaceResult({ requestId: "r1", error: { code: "denied", message: "Denied" } }), true);
  assert.equal(validWorkspaceResult({ requestId: "r1", data: { action: "list", entries: [null] } }), false);
  assert.equal(validWorkspaceResult({ requestId: "r1", data: { action: "changes", entries: [], base: 42 } }), false);
  assert.equal(validWorkspaceResult({ requestId: "r1", data: { action: "list", scope: "workspace", entries: [] } }), true);
  assert.equal(validWorkspaceResult({ requestId: "r1", data: { action: "list", scope: "touched", entries: [] } }), true);
  assert.equal(validWorkspaceResult({ requestId: "r1", data: { action: "list", scope: "anything", entries: [] } }), false);
});
