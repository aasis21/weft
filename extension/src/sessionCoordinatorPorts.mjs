// SPDX-License-Identifier: Apache-2.0

const REQUIRED_METHODS = Object.freeze({
  journal: ["begin", "read", "update", "listUnresolved", "cleanup"],
  connections: ["findHealthyCard", "reconnect"],
  runtimeDirectory: ["locateTarget", "locateOperation"],
  runtimeControl: ["activate", "status"],
  sessions: ["resolve"],
  projects: ["resolve"],
  identities: ["create"],
  launcher: ["start", "resume"],
  processes: ["inspect"],
  clock: ["now"],
});

/**
 * Runtime dependency contract for SessionCoordinator.
 *
 * Ports deliberately separate policy from filesystem, process, IPC, session-store,
 * project-catalog, identity, and launch implementations. Production integration can
 * adapt the existing Station helpers without importing listener.mjs.
 */
export function assertSessionCoordinatorPorts(ports) {
  if (!ports || typeof ports !== "object") throw new TypeError("SessionCoordinator ports are required");
  for (const [portName, methods] of Object.entries(REQUIRED_METHODS)) {
    const port = ports[portName];
    if (!port || typeof port !== "object") {
      throw new TypeError(`SessionCoordinator port '${portName}' is required`);
    }
    for (const method of methods) {
      if (typeof port[method] !== "function") {
        throw new TypeError(`SessionCoordinator port '${portName}.${method}' must be a function`);
      }
    }
  }
  return ports;
}

export function createNoopDiagnostics() {
  return Object.freeze({ record() {} });
}
