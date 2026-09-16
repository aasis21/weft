// SPDX-License-Identifier: Apache-2.0
import { joinSession } from "@github/copilot-sdk/extension";
import { startExtensionBootstrap } from "./extensionBootstrap.mjs";

await startExtensionBootstrap({ joinSession });
