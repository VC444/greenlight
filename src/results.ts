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
    ? `\n\n▶️ [Watch the session replay](${result.replayUrl}) <sub>(Browserbase links expire after 7 days)</sub>`
    : "";
}

/**
 * Posts a completed check run for this push. Returns its html_url (to link from
 * the comment) or null when the check can't be created — most likely the App is
 * missing "Checks: Read & write", which we surface as a fix-it rather than a red.
 */
async function postCheckRun(
  octokit: Octokit,
  job: PullRequestJob,
  plan: TestPlan,
  result: ExecutionResult,
): Promise<string | null> {
  const label = `${job.owner}/${job.repo}#${job.prNumber}`;
  const t = tally(result.items);
  const summary = `${plan.summary}\n\n**${headline(t)}** across ${t.total} check(s).${replayLine(result)}`;

  try {
    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/check-runs",
      {
        owner: job.owner,
        repo: job.repo,
        name: CHECK_NAME,
        head_sha: job.headSha,
        status: "completed",
        conclusion: conclusion(t),
        completed_at: new Date().toISOString(),
        output: {
          title: headline(t),
          summary,
          text: renderItems(result.items),
        },
      },
    );
    console.log(
      `posted check run for ${label}: ${conclusion(t)} (${headline(t)})`,
    );
    return data.html_url ?? null;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { status?: number }).status === 403
    ) {
      console.warn(
        `check run for ${label} forbidden — the GitHub App needs "Checks: Read & write". ` +
          `Grant it in the App's repository permissions and accept the update. Posting the results comment only.`,
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

function renderResultsComment(
  plan: TestPlan,
  result: ExecutionResult,
  headSha: string,
  checkUrl: string | null,
): string {
  const t = tally(result.items);
  const lines = [
    `### 🟢 Greenlight — results`,
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
    `<sub>Ran against the Vercel preview for \`${headSha.slice(0, 7)}\`${check} · a ❌ is a finding to look at, not a merge blocker · ❔ means the run couldn't reach a verdict (it broke, or the outcome wasn't observable from the page)</sub>`,
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
  const checkUrl = await postCheckRun(octokit, job, plan, result);
  await upsertResultsComment(octokit, job, plan, result, checkUrl);
}
