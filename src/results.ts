import type { getInstallationOctokit } from "./github.js";
import type { PullRequestJob } from "./queue.js";
import type { TestPlan } from "./testplan.js";
import type { ExecutionResult, ItemEvidence } from "./execute.js";

type Octokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

const CHECK_NAME = "Greenlight";

// The results comment is bot-owned output (not human-correctable like the plan
// comment), so it needs no edit-detection — just a marker to find and upsert it,
// carrying the SHA it reflects so a stale comment is obvious.
const RESULTS_MARKER_RE = /^<!-- greenlight:results sha:(\S+) -->\n?/;

interface Tally {
  pass: number;
  fail: number;
  uncertain: number;
  total: number;
}

function tally(items: ItemEvidence[]): Tally {
  return {
    pass: items.filter((i) => i.verdict === "pass").length,
    fail: items.filter((i) => i.verdict === "fail").length,
    uncertain: items.filter((i) => i.verdict === "uncertain").length,
    total: items.length,
  };
}

const VERDICT_ICON: Record<ItemEvidence["verdict"], string> = {
  pass: "✅",
  fail: "❌",
  uncertain: "❔",
};

/**
 * Check-run conclusion from the verdicts. A FAIL is neutral, never red — a false
 * positive from the LLM judge must never gate a merge ("prefer silence over a
 * wrong red"). "uncertain" (the run itself broke) is also neutral. Only an
 * all-pass run is green.
 */
function conclusion(t: Tally): "success" | "neutral" {
  if (t.fail > 0 || t.uncertain > 0) return "neutral";
  return "success";
}

function headline(t: Tally): string {
  const parts: string[] = [];
  if (t.pass) parts.push(`${t.pass} passed`);
  if (t.fail) parts.push(`${t.fail} failed`);
  if (t.uncertain) parts.push(`${t.uncertain} inconclusive`);
  return parts.join(", ") || "no items run";
}

/** Per-item markdown, shared by the check-run body and the results comment. */
function renderItems(items: ItemEvidence[]): string {
  return items
    .map((item) => {
      const lines = [
        `- ${VERDICT_ICON[item.verdict]} **${item.intent}** — \`${item.route}\``,
      ];
      const detail = item.error ?? item.reasoning;
      if (detail) lines.push(`  ${detail}`);
      if (item.consoleErrors.length) {
        lines.push(
          `  <sub>${item.consoleErrors.length} console error(s) during this journey</sub>`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");
}

function replayLine(result: ExecutionResult): string {
  return result.replayUrl
    ? `\n\n▶️ [Watch the session replay](${result.replayUrl})`
    : "";
}

/** Our check run for this SHA, if one is already there to update. */
async function findCheckRun(
  octokit: Octokit,
  job: PullRequestJob,
): Promise<number | null> {
  const { data } = await octokit.request(
    "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
    {
      owner: job.owner,
      repo: job.repo,
      ref: job.headSha,
      check_name: CHECK_NAME,
      per_page: 100,
    },
  );
  return data.check_runs[0]?.id ?? null;
}

interface CheckContent {
  conclusion: "success" | "neutral";
  title: string;
  summary: string;
  text?: string;
}

/**
 * Creates our check run for this push, or updates the one already there.
 *
 * Upsert rather than post, because a single run can report twice: it says
 * "paused" while a human holds the gate open, then replaces that with the
 * verdicts once they let it go. Two check runs of the same name on one commit
 * would leave the stale one visible next to the real answer.
 *
 * Returns its html_url (to link from the comment), or null when the check can't
 * be written — most likely a missing "Checks: Read & write", which we surface as
 * a fix-it rather than a red.
 */
async function upsertCheckRun(
  octokit: Octokit,
  job: PullRequestJob,
  content: CheckContent,
): Promise<string | null> {
  const label = `${job.owner}/${job.repo}#${job.prNumber}`;
  const shared = {
    owner: job.owner,
    repo: job.repo,
    status: "completed" as const,
    conclusion: content.conclusion,
    completed_at: new Date().toISOString(),
    output: {
      title: content.title,
      summary: content.summary,
      ...(content.text ? { text: content.text } : {}),
    },
  };

  try {
    const existingId = await findCheckRun(octokit, job);
    const { data } = existingId
      ? await octokit.request(
          "PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}",
          { ...shared, check_run_id: existingId },
        )
      : await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
          ...shared,
          name: CHECK_NAME,
          head_sha: job.headSha,
        });
    console.log(
      `${existingId ? "updated" : "posted"} check run for ${label}: ${content.conclusion} (${content.title})`,
    );
    return data.html_url ?? null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { status?: number }).status === 403
    ) {
      console.warn(
        `check run for ${label} forbidden — the workflow needs "checks: write" ` +
          `(a GitHub App needs "Checks: Read & write"). Continuing without it.`,
      );
      return null;
    }
    // Any other failure: don't let the check block the results comment.
    console.warn(
      `check run for ${label} failed:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Says on the PR that a human unchecked the run box and we are holding.
 *
 * Neutral, like everything else Greenlight posts, so a paused run can never
 * gate a merge. It exists because the alternative is a workflow that idles with
 * no visible reason, which reads as broken to everyone who didn't click the box.
 */
export async function reportPaused(
  octokit: Octokit,
  job: PullRequestJob,
): Promise<void> {
  await upsertCheckRun(octokit, job, {
    conclusion: "neutral",
    title: "Paused — waiting for you",
    summary:
      "The run checkbox on the plan comment is unchecked, so nothing is running.\n\n" +
      "Edit the plan however you like, then check the box to run it. " +
      "Pushing a new commit also starts over with a fresh plan.",
  });
}

function renderResultsComment(
  plan: TestPlan,
  result: ExecutionResult,
  headSha: string,
  checkUrl: string | null,
): string {
  const t = tally(result.items);
  const lines = [
    `### 🎄 Greenlight Results:`,
    "",
    `**${headline(t)}** across ${t.total} check(s).`,
    "",
    renderItems(result.items),
  ];
  const replay = replayLine(result).trim();
  if (replay) lines.push("", replay);
  const check = checkUrl ? ` · [details](${checkUrl})` : "";
  lines.push(
    "",
    `<sub>Ran against the Vercel preview for \`${headSha.slice(0, 7)}\`${check} · ❔ means the run couldn't reach a verdict (it broke, or the outcome wasn't observable from the page)</sub>`,
  );
  return lines.join("\n");
}

async function findResultsComment(
  octokit: Octokit,
  job: PullRequestJob,
): Promise<number | null> {
  const { data: comments } = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    {
      owner: job.owner,
      repo: job.repo,
      issue_number: job.prNumber,
      per_page: 100,
    },
  );
  for (const comment of comments) {
    if (comment.body && RESULTS_MARKER_RE.test(comment.body)) return comment.id;
  }
  return null;
}

/** Posts or updates the results comment (separate from the plan comment). */
async function upsertResultsComment(
  octokit: Octokit,
  job: PullRequestJob,
  plan: TestPlan,
  result: ExecutionResult,
  checkUrl: string | null,
): Promise<void> {
  const label = `${job.owner}/${job.repo}#${job.prNumber}`;
  const content = renderResultsComment(plan, result, job.headSha, checkUrl);
  const body = `<!-- greenlight:results sha:${job.headSha} -->\n${content}`;
  const existingId = await findResultsComment(octokit, job);

  if (existingId !== null) {
    await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {
        owner: job.owner,
        repo: job.repo,
        comment_id: existingId,
        body,
      },
    );
    console.log(`updated results comment on ${label}`);
  } else {
    await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: job.owner,
        repo: job.repo,
        issue_number: job.prNumber,
        body,
      },
    );
    console.log(`posted results comment on ${label}`);
  }
}

/**
 * Surfaces an execution's verdicts on the PR: a completed check run (the
 * SHA-attached gate — neutral by default so a false judge never shows red) plus
 * an upserted results comment (re-runs update it in place, no spam). Either
 * surface failing is logged and swallowed — reporting must never crash a job.
 */
export async function reportResults(
  octokit: Octokit,
  job: PullRequestJob,
  plan: TestPlan,
  result: ExecutionResult,
): Promise<void> {
  const t = tally(result.items);
  const checkUrl = await upsertCheckRun(octokit, job, {
    conclusion: conclusion(t),
    title: headline(t),
    summary: `${plan.summary}\n\n**${headline(t)}** across ${t.total} check(s).${replayLine(result)}`,
    text: renderItems(result.items),
  });
  await upsertResultsComment(octokit, job, plan, result, checkUrl);
}
