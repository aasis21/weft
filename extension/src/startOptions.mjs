// SPDX-License-Identifier: Apache-2.0

export function parseStartOptions(args = []) {
  const options = { help: false, newDevice: false };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--new-device" || arg === "--rotate-pairing") {
      options.newDevice = true;
    } else if (arg === "--allow-terminal") {
      throw new Error("Terminal access is enabled by default. Configure terminal.enabled in ~/.weft/weft.config.json, then run `weft start` without --allow-terminal.");
    } else {
      throw new Error(`Unknown option for weft start: ${arg}\nRun \`weft start --help\` for supported options.`);
    }
  }
  return options;
}
