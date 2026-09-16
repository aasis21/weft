// SPDX-License-Identifier: Apache-2.0

export function normalizeOpenIntent(intent) {
  const operationId = typeof intent?.operationId === "string" ? intent.operationId.trim() : "";
  if (!operationId) throw new TypeError("Open intent operationId is required");
  const target = intent?.target;
  if (target?.kind === "new") {
    const projectName = typeof target.projectName === "string" ? target.projectName.trim() : "";
    if (!projectName) throw new TypeError("New-session target projectName is required");
    return {
      operationId,
      target: { kind: "new", projectName },
      mode: intent?.mode === "allow-all" ? "allow-all" : "default",
      name: typeof intent?.name === "string" && intent.name.trim() ? intent.name.trim() : null,
      requesterId:
        typeof intent?.requesterId === "string" && intent.requesterId.trim() ? intent.requesterId.trim() : null,
    };
  }
  if (target?.kind === "existing") {
    const storeAuthority =
      typeof target.storeAuthority === "string" && target.storeAuthority.trim()
        ? target.storeAuthority.trim()
        : "default";
    const sessionId = typeof target.sessionId === "string" ? target.sessionId.trim() : "";
    if (!sessionId) throw new TypeError("Existing-session target sessionId is required");
    return {
      operationId,
      target: { kind: "existing", storeAuthority, sessionId },
      mode: intent?.mode === "allow-all" ? "allow-all" : "default",
      name: null,
      takeoverRequested: intent?.takeoverRequested === true,
      requesterId:
        typeof intent?.requesterId === "string" && intent.requesterId.trim() ? intent.requesterId.trim() : null,
    };
  }
  throw new TypeError("Open intent target must be 'new' or 'existing'");
}

export function targetReservationKey(target, operationId) {
  return target.kind === "existing"
    ? `existing:${target.storeAuthority}:${target.sessionId}`
    : `new:${operationId}`;
}

function failure(code, message, retryable = false) {
  return { outcome: "fail-closed", failure: { code, message, retryable } };
}

export function resolveSessionOpen({
  intent,
  healthyCard = null,
  reconnect = { status: "not-found" },
  runtimes = { status: "none" },
  savedSession = null,
  project = null,
} = {}) {
  if (intent?.target?.kind === "new") {
    if (!project) return failure("project-not-found", `Unknown project: ${intent.target.projectName}`);
    if (project.directoryExists !== true) {
      return failure("directory-not-found", "The requested project's directory is unavailable.");
    }
    return { outcome: "start", project };
  }

  if (healthyCard) return { outcome: "open-existing", card: healthyCard };
  if (reconnect?.status === "confirmed") return { outcome: "reconnect", connection: reconnect.connection ?? null };
  if (runtimes?.status === "multiple") {
    return failure("writer-conflict", "Multiple live runtimes claim this session.");
  }
  if (runtimes?.status === "legacy-writer") {
    if (intent?.takeoverRequested === true) {
      return { outcome: "legacy-takeover", writer: runtimes.writer, session: savedSession };
    }
    return failure(
      "writer-conflict",
      runtimes.writer?.healthy
        ? "That session is already running on this laptop and connected to a phone. Resume again to close it and take it over."
        : "That session still has a running Copilot writer. Use force takeover to close it before resuming.",
    );
  }
  if (runtimes?.status === "single") return { outcome: "activate-live", runtime: runtimes.runtime };
  if (!savedSession) return failure("session-not-found", "That session is no longer in the CLI session store.");
  if (runtimes?.status !== "none") {
    return failure("ownership-unknown", "The session writer could not be proven live or stopped.", true);
  }
  if (savedSession.directoryExists !== true) {
    return failure("directory-not-found", "The session working directory is unavailable.");
  }
  if (savedSession.writerState !== "stopped") {
    return failure("ownership-unknown", "The session writer could not be proven stopped.", true);
  }
  return { outcome: "resume", session: savedSession };
}
