/**
 * pi-provider — interactive provider/model manager for pi.
 *
 * Adds a `/pi-provider` command for managing custom providers in
 * `~/.pi/agent/models.json` (see https://pi.dev/docs/latest/models):
 * add / delete / modify providers and their models.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runProviderManager } from "./lib/wizard.ts";

export default function providerManager(pi: ExtensionAPI) {
	pi.registerCommand("pi-provider", {
		description:
			"Manage custom providers and models in models.json (add / delete / modify)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				ctx.ui.notify("/pi-provider requires interactive mode", "error");
				return;
			}
			await runProviderManager(ctx);
		},
	});
}
