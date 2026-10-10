// SPDX-License-Identifier: Apache-2.0
import * as sdk from "@github/copilot-sdk/extension";
import { startExtensionBootstrap } from "./extensionBootstrap.mjs";

await startExtensionBootstrap({ joinSession: sdk.joinSession, createCanvas: sdk.createCanvas });
