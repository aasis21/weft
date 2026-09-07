// SPDX-License-Identifier: Apache-2.0

export function parseStartOptions(args = []) {
  const options = { help: false, newDevice: false };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--new-device" || arg === "--rotate-pairing") {
      options.newDevice = true;
    } else {
      throw new Error(`Unknown option for weft start: ${arg}\nRun \`weft start --help\` for supported options.`);
    }
  }
  return options;
}
