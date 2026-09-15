// Firefox MV2 persistent background-page entry point.
// SPDX-License-Identifier: GPL-3.0-or-later

import { createFirefoxBackgroundHost } from "./firefox-host.js";

const host = createFirefoxBackgroundHost(document);
await import("./background.js");
host.mount();
