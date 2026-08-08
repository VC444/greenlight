import type { getInstallationOctokit } from "./github.js";
import type { PullRequestJob } from "./queue.js";
import { gatherPrContext } from "./context.js";
import { generateTestPlan, type TestPlan } from "./testplan.js";
import {
  upsertPlanComment,
  readPlanComment,
  type ParsedPlanComment,
} from "./comment.js";
import { waitForPreview, type PreviewResult } from "./preview.js";
import { runPlan } from "./execute.js";
import { reportResults, reportPaused } from "./results.js";
import { config } from "./config.js";
import { MOCK_PLAN } from "./mockPlan.js";

type Octokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type Gate =
  /** The box is checked; this is the plan as it stands, human edits included. */
  | { status: "run"; comment: ParsedPlanComment }
  /** Nobody checked it back on before the budget ran out. */
  | { status: "paused" }
  /** The comment is gone, or now belongs to a newer push. Not ours to run. */
  | { status: "superseded" };

/**
 * Blocks until the run checkbox is checked.
 *
 * The default is checked, so this normally returns on its first read and costs
 * one API call. It only ever waits because a human deliberately unchecked the
 * box, which is them asking for time to correct the plan — the run holds the
 * runner open for that, since a workflow run is the only thing still listening.
 */
async function awaitRunBox(
  octokit: Octokit,
  job: PullRequestJob,
  label: string,
): Promise<Gate> {
  const deadline = Date.now() + config.pauseTimeoutMs;
  let announced = false;

  while (true) {
    const comment = await readPlanComment(octokit, job);
    // Deleting the comment is a legitimate way to call the whole thing off.
    if (!comment) return { status: "superseded" };
    // A newer push rewrote the plan, so this run is testing the wrong commit.
    // The workflow's concurrency group usually cancels us first; this is what
    // catches the case where it doesn't.
    if (comment.headSha !== job.headSha) return { status: "superseded" };
    if (comment.run) return { status: "run", comment };

    if (!announced) {
      announced = true;
      console.log(
        `run box unchecked on ${label} — holding for up to ` +
          `${Math.round(config.pauseTimeoutMs / 60_000)} min while the plan is edited`,
      );
      await reportPaused(octokit, job);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { status: "paused" };
    await sleep(Math.min(config.pausePollMs, remaining));
  }
}

function logPreviewProblem(preview: PreviewResult, label: string): void {
  switch (preview.status) {
    case "failed":
      console.warn(
        `preview unavailable for ${label}: ${preview.reason} — staying silent`,
      );
      break;
    case "timeout":
      console.warn(
        `preview for ${label} did not go ready in time — staying silent`,
      );
      break;
    case "none":
      console.log(`no Vercel preview for ${label} — nothing to test against`);
      break;
  }
}

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

  // Past this point the comment is authoritative, not the plan we just
  // generated. A human can uncheck items, reword a step, or uncheck the run box
  // to hold us while they think, so every decision below re-reads it rather
  // than trusting what we posted.
  while (true) {
    const gate = await awaitRunBox(octokit, job, label);
    if (gate.status === "superseded") {
      console.log(`plan comment for ${label} is gone or superseded — stopping`);
      return;
    }
    if (gate.status === "paused") {
      console.log(
        `run box on ${label} was never checked back on — stopping. ` +
          `Checking it later won't reach this run; push again to start over.`,
      );
      return;
    }

    const preview = await waitForPreview(octokit, job);
    if (preview.status !== "ready") {
      logPreviewProblem(preview, label);
      return;
    }

    // Last look before spending a browser on it. The preview can take minutes
    // to build, which is plenty of time for someone to uncheck the box or fix a
    // step — and this is the final moment either can still count.
    const current = await readPlanComment(octokit, job);
    if (!current || current.headSha !== job.headSha) {
      console.log(`plan comment for ${label} is gone or superseded — stopping`);
      return;
    }
    if (!current.run) {
      console.log(`run box on ${label} was unchecked while the preview built`);
      continue;
    }
    if (current.plan.items.length === 0) {
      console.log(`every item on ${label} was unchecked — nothing to run`);
      return;
    }
    if (current.skipped > 0) {
      console.log(`${current.skipped} item(s) unchecked on ${label} — skipping them`);
    }

    console.log(`preview ready for ${label}: ${preview.url} — executing plan`);
    const result = await runPlan(preview.url, current.plan);
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
      await reportResults(octokit, job, current.plan, result);
    }
    return;
  }
}
