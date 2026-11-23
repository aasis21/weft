// SPDX-License-Identifier: Apache-2.0
import * as sdk from "@github/copilot-sdk/extension";
import { startSessionHost } from "./sessionHost.mjs";

await startSessionHost({ joinSession: sdk.joinSession, createCanvas: sdk.createCanvas });
