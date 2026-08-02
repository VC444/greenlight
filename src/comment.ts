import { createHash } from "node:crypto";
import type { getInstallationOctokit } from "./github.js";
import type { PullRequestJob } from "./queue.js";
import type { TestPlan } from "./testplan.js";

type Octokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

// The PR comment is the only persistent state: a hidden marker carries a hash
// of the body we wrote (so we can tell when a human edited it) and the time we
// wrote it (so a 👎 left on an older plan doesn't force regeneration forever).
const MARKER_RE = /^<!-- greenlight:plan hash:([a-f0-9]{12}) at:(\S+) -->\n?/;

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function stripMarker(body: string): string {
  return body.replace(MARKER_RE, "");
}

interface ExistingPlanComment {
  id: number;
  body: string;
  hash: string;
  generatedAt: string;
}

async function findPlanComment(
  octokit: Octokit,
  job: PullRequestJob,
): Promise<ExistingPlanComment | null> {
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
    const match = comment.body?.match(MARKER_RE);
    if (match?.[1] && match[2]) {
      return {
        id: comment.id,
        body: comment.body ?? "",
        hash: match[1],
        generatedAt: match[2],
      };
    }
  }
  return null;
}

/** True if a human left a 👎 after the current plan was posted. */
async function hasFreshThumbsDown(
  octokit: Octokit,
  job: PullRequestJob,
  comment: ExistingPlanComment,
): Promise<boolean> {
  const { data: reactions } = await octokit.request(
    "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
    { owner: job.owner, repo: job.repo, comment_id: comment.id, per_page: 100 },
  );
  const since = Date.parse(comment.generatedAt);
  return reactions.some(
    (r) =>
      r.content === "-1" &&
      r.user?.type !== "Bot" &&
      (Number.isNaN(since) || Date.parse(r.created_at) > since),
  );
}

function renderPlan(plan: TestPlan, headSha: string): string {
  const lines: string[] = ["### 🎄 Greenlight: what I'll verify", ""];
  const note =
    plan.confidence === "low"
      ? " _(low confidence, inferred from the diff alone)_"
      : "";
  lines.push(`${plan.summary}${note}`, "");
  for (const item of plan.items) {
    lines.push(`- [x] **${item.intent}** (\`${item.route}\`)`);
    for (const [i, step] of item.steps.entries()) {
      lines.push(`  ${i + 1}. ${step}`);
    }
    lines.push("");
    lines.push(`  **Expect:** ${item.expected}`);
  }
  lines.push(
    "",
    `<sub>Plan for \`${headSha.slice(0, 7)}\` · uncheck a box to skip that test · edit the text to correct it (your edits stick) · react 👎 for a fresh plan on the next push · no action needed otherwise</sub>`,
  );
  return lines.join("\n");
}

function renderNothingToTest(plan: TestPlan, headSha: string): string {
  return [
    "### 🎄 Greenlight: nothing to verify",
    "",
    plan.summary,
    "",
    `<sub>As of \`${headSha.slice(0, 7)}\` this change has no browser-testable surface, so I'll sit it out.</sub>`,
  ].join("\n");
}

/**
 * Posts the plan as the PR comment, or updates the existing one. Human edits
 * to the comment are corrections and are preserved — we only overwrite when
 * the body still matches what we wrote, or when a fresh 👎 asks for a redo.
 */
export async function upsertPlanComment(
  octokit: Octokit,
  job: PullRequestJob,
  plan: TestPlan,
): Promise<void> {
  const label = `${job.owner}/${job.repo}#${job.prNumber}`;
  const existing = await findPlanComment(octokit, job);

  // Never open the conversation just to say there's nothing to do.
  if (!existing && plan.items.length === 0) {
    console.log(
      `no testable items for ${label} and no existing comment; staying silent`,
    );
    return;
  }

  if (existing) {
    const humanEdited =
      contentHash(stripMarker(existing.body)) !== existing.hash;
    if (humanEdited && !(await hasFreshThumbsDown(octokit, job, existing))) {
      console.log(
        `plan comment on ${label} was human-edited; preserving their corrections`,
      );
      return;
    }
  }

  const content =
    plan.items.length > 0
      ? renderPlan(plan, job.headSha)
      : renderNothingToTest(plan, job.headSha);
  const body = `<!-- greenlight:plan hash:${contentHash(content)} at:${new Date().toISOString()} -->\n${content}`;

  if (existing) {
    await octokit.request(
      "PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
      {
        owner: job.owner,
        repo: job.repo,
        comment_id: existing.id,
        body,
      },
    );
    console.log(`updated plan comment on ${label}`);
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
    console.log(`posted plan comment on ${label}`);
  }
}
