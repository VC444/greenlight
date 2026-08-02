import { getInstallationOctokit } from "./github.js";
import { queue } from "./queue.js";
import { processJob } from "./pipeline.js";

/**
 * Drains the queue forever. Per-job errors are logged and swallowed so one
 * bad job can never kill the loop — when in doubt, stay silent on the PR.
 */
export async function startWorker(): Promise<void> {
  console.log("worker started");
  while (true) {
    const job = await queue.pop();
    try {
      const octokit = await getInstallationOctokit(job.installationId);
      await processJob(octokit, job);
    } catch (error) {
      console.error(
        `job failed for ${job.owner}/${job.repo}#${job.prNumber}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
