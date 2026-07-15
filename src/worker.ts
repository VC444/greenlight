import { getInstallationOctokit } from "./github.js";
import { queue, type PullRequestJob } from "./queue.js";

async function processJob(job: PullRequestJob): Promise<void> {
  const octokit = await getInstallationOctokit(job.installationId);
  await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
    owner: job.owner,
    repo: job.repo,
    issue_number: job.prNumber,
    body: `👋 Greenlight saw this PR (\`${job.action}\`, head \`${job.headSha.slice(0, 7)}\`). Test runs coming soon.`,
  });
  console.log(`commented on ${job.owner}/${job.repo}#${job.prNumber}`);
}

/**
 * Drains the queue forever. Per-job errors are logged and swallowed so one
 * bad job can never kill the loop — when in doubt, stay silent on the PR.
 */
export async function startWorker(): Promise<void> {
  console.log("worker started");
  while (true) {
    const job = await queue.pop();
    try {
      await processJob(job);
    } catch (error) {
      console.error(
        `job failed for ${job.owner}/${job.repo}#${job.prNumber}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
