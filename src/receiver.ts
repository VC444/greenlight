import { createNodeMiddleware } from "@octokit/webhooks";
import { app } from "./github.js";
import { queue } from "./queue.js";
import { config } from "./config.js";

const HANDLED_ACTIONS = ["opened", "synchronize"] as const;

for (const action of HANDLED_ACTIONS) {
  app.webhooks.on(`pull_request.${action}`, ({ payload }) => {
    if (!payload.installation) {
      console.warn(`pull_request.${action} without installation id — ignoring`);
      return;
    }
    queue.push({
      installationId: payload.installation.id,
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      prNumber: payload.pull_request.number,
      headSha: payload.pull_request.head.sha,
      action,
    });
    console.log(
      `enqueued ${payload.repository.full_name}#${payload.pull_request.number} (${action}), queue size ${queue.size}`,
    );
  });
}

app.webhooks.onError((error) => {
  console.error(`webhook error: ${error.message}`);
});

/**
 * Express-compatible handler. Verifies the webhook signature and acks 200 as
 * soon as the event handlers above have enqueued (no real work inline —
 * GitHub retries slow deliveries). Calls next() for non-webhook paths.
 */
export const webhookMiddleware = createNodeMiddleware(app.webhooks, {
  path: config.webhookPath,
});
