import type { getInstallationOctokit } from "./github.js";
import type { PullRequestJob } from "./queue.js";
import { gatherPrContext } from "./context.js";
import { generateTestPlan, type TestPlan } from "./testplan.js";
import { upsertPlanComment } from "./comment.js";
import { waitForPreview } from "./preview.js";
import { runPlan } from "./execute.js";
import { reportResults } from "./results.js";
import { config } from "./config.js";
import { MOCK_PLAN } from "./mockPlan.js";

type Octokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

/**
 * The whole run for one pull request event: context → plan → comment → preview
 * → execution → results.
 *
 * It takes an authenticated client rather than building one, because how that
 * client was obtained is the only thing that differs between the two entry
 * points — the App resolves an installation token, the Action uses the runner's
 * GITHUB_TOKEN. Keep it that way: nothing below this line should learn which
 * one it is running under, or the Action stops working in ways the App never
 * reveals.
 */
export async function processJob(octokit: Octokit, job: PullRequestJob): Promise<void> {
  const label = `${job.owner}/${job.repo}#${job.prNumber}`;

  let plan: TestPlan | null;
  if (config.useMockPlan) {
    // Deterministic fixture instead of the model — validates the pipeline
    // (comment → preview → execution) without spending LLM credits.
    console.log(`mock-plan mode: using fixture plan for ${label} (no LLM call)`);
    plan = MOCK_PLAN;
  } else {
    console.log(`gathering context for ${label} (${job.action}, head ${job.headSha.slice(0, 7)})`);
    const context = await gatherPrContext(octokit, job);
    console.log(
      `context: ${context.changedFiles.length} files, ${context.commitMessages.length} commits,` +
        ` issue ${context.linkedIssue ? `#${context.linkedIssue.number}` : "none"}` +
        `${context.truncated ? ", truncated" : ""}`,
    );
    plan = await generateTestPlan(context);
  }

  if (!plan) {
    console.warn(`no test plan for ${label} — staying silent`);
    return;
  }

  console.log(
    `test plan for ${label} (confidence: ${plan.confidence}, ${plan.items.length} items): ${plan.summary}`,
  );
  await upsertPlanComment(octokit, job, plan);

  // Nothing browser-testable means no reason to wait on a preview.
  if (plan.items.length === 0) return;

  // The plan is posted; now wait for Vercel's preview to build. That wait is
  // also the window in which a human can correct the plan before we execute it.
  const preview = await waitForPreview(octokit, job);
  switch (preview.status) {
    case "ready": {
      console.log(`preview ready for ${label}: ${preview.url} — executing plan`);
      const result = await runPlan(preview.url, plan);
      if (result) {
        const pass = result.items.filter((i) => i.verdict === "pass").length;
        const fail = result.items.filter((i) => i.verdict === "fail").length;
        const uncertain = result.items.filter((i) => i.verdict === "uncertain").length;
        console.log(
          `executed ${result.items.length} item(s) for ${label}: ` +
            `${pass} pass, ${fail} fail, ${uncertain} uncertain` +
            ` — replay ${result.replayUrl ?? "n/a"}`,
        );
        // Surface the verdicts on the PR: check run + results comment.
        await reportResults(octokit, job, plan, result);
      }
      break;
    }
    case "failed":
      console.warn(`preview unavailable for ${label}: ${preview.reason} — staying silent`);
      break;
    case "timeout":
      console.warn(`preview for ${label} did not go ready in time — staying silent`);
      break;
    case "none":
      console.log(`no Vercel preview for ${label} — nothing to test against`);
      break;
  }
}
