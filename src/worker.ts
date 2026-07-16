import { getInstallationOctokit } from "./github.js";
import { queue, type PullRequestJob } from "./queue.js";
import { gatherPrContext } from "./context.js";
import { generateTestPlan } from "./testplan.js";

async function processJob(job: PullRequestJob): Promise<void> {
  const label = `${job.owner}/${job.repo}#${job.prNumber}`;
  const octokit = await getInstallationOctokit(job.installationId);

  console.log(`gathering context for ${label} (${job.action}, head ${job.headSha.slice(0, 7)})`);
  const context = await gatherPrContext(octokit, job);
  console.log(
    `context: ${context.changedFiles.length} files, ${context.commitMessages.length} commits,` +
      ` issue ${context.linkedIssue ? `#${context.linkedIssue.number}` : "none"}` +
      `${context.truncated ? ", truncated" : ""}`,
  );

  const plan = await generateTestPlan(context);
  if (!plan) {
    console.warn(`no test plan for ${label} — staying silent`);
    return;
  }

  // Phase 2 will post this as a PR comment; for now the log is the output.
  console.log(`test plan for ${label} (confidence: ${plan.confidence}):`);
  console.log(`  summary: ${plan.summary}`);
  if (plan.items.length === 0) {
    console.log("  no browser-testable items");
  }
  for (const [i, item] of plan.items.entries()) {
    console.log(`  ${i + 1}. ${item.intent} [${item.route}]`);
    for (const step of item.steps) console.log(`       - ${step}`);
    console.log(`       expect: ${item.expected}`);
  }
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
