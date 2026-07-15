import { App } from "@octokit/app";
import { config } from "./config.js";

export const app = new App({
  appId: config.appId,
  privateKey: config.privateKey,
  webhooks: { secret: config.webhookSecret },
});

/**
 * Octokit authenticated as the App's installation on the target repo.
 * Installation tokens are fetched on demand and cached in memory by
 * @octokit/app; nothing is persisted.
 */
export function getInstallationOctokit(installationId: number) {
  return app.getInstallationOctokit(installationId);
}
