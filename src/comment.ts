import type { getInstallationOctokit } from "./github.js";
import type { PullRequestJob } from "./queue.js";
import type { TestPlan } from "./testplan.js";

type Octokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

// The plan comment is the live state for exactly one head SHA, and the marker
// says which. Every push regenerates the plan and overwrites this comment
// wholesale: a human's corrections are consumed by the run they were written
// for, and new code deserves a plan about the new code. Nothing here is meant
// to survive a commit, which is why there is no edit detection.
//
// Confidence rides in the marker rather than being recovered from the prose,
// so parsing never has to interpret an English sentence a human may have
// rewritten.
const MARKER_RE = /^<!-- greenlight:plan sha:(\S+) confidence:(high|low) -->\n?/;

// Tags the one checkbox that gates execution so parsing can never confuse it
// with the per-item boxes. It sits at the end of the line because GitHub
// rewrites task-list checkboxes by source position when someone clicks one —
// keep the "- [ ] " prefix pristine. Renders as nothing.
const RUN_TOKEN = "<!-- greenlight:run -->";
const RUN_RE = /^- \[([ xX])\].*<!-- greenlight:run -->\s*$/m;

// Steps and the expectation are indented under their item. We render steps as a
// numbered list, but accept dashes and any indent depth: someone correcting a
// plan by hand types what looks right, not what we happened to emit.
const ITEM_RE = /^- \[([ xX])\] \*\*(.+?)\*\* \(`(.+?)`\)\s*$/;
const STEP_RE = /^ {2,}(?:\d+[.)]|[-*]) (.+?)\s*$/;
const EXPECT_RE = /^ {2,}\*\*Expect:\*\*\s*(.+?)\s*$/;

/** The plan comment as it stands right now, which is the thing we execute. */
export interface ParsedPlanComment {
  id: number;
  /** The SHA this plan was written for. Mismatch means a newer push replaced it. */
  headSha: string;
  /** The gate checkbox: false means a human paused us to think. */
  run: boolean;
  /** Checked items only, in comment order. */
  plan: TestPlan;
  /** How many items a human unchecked, for logging. */
  skipped: number;
}

interface RawComment {
  id: number;
  body: string;
}

async function findPlanComment(
  octokit: Octokit,
  job: PullRequestJob,
): Promise<RawComment | null> {
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
    if (comment.body && MARKER_RE.test(comment.body)) {
      return { id: comment.id, body: comment.body };
    }
  }
  return null;
}

function isChecked(box: string): boolean {
  return box.toLowerCase() === "x";
}

/**
 * Reads a rendered plan comment back into a plan. This is the only reason the
 * rendering below is disciplined: the comment is a UI a human edits, and
 * whatever they leave behind is what we run.
 */
export function parsePlanBody(body: string): Omit<ParsedPlanComment, "id"> | null {
  const marker = body.match(MARKER_RE);
  if (!marker?.[1] || !marker[2]) return null;
  const headSha = marker[1];
  const confidence = marker[2] as TestPlan["confidence"];

  const runBox = body.match(RUN_RE);
  // A "nothing to verify" comment carries no gate at all; there is nothing to
  // hold back, so treat its absence as "go".
  const run = runBox?.[1] ? isChecked(runBox[1]) : true;

  const summaryParts: string[] = [];
  const items: TestPlan["items"] = [];
  let skipped = 0;

  interface Draft {
    checked: boolean;
    intent: string;
    route: string;
    steps: string[];
    expected: string;
  }
  let draft: Draft | null = null;

  const flush = (): void => {
    if (!draft) return;
    if (!draft.checked) {
      skipped++;
    } else if (draft.expected) {
      items.push({
        intent: draft.intent,
        route: draft.route,
        steps: draft.steps,
        expected: draft.expected,
      });
    } else {
      // A human deleted or mangled the Expect line, so there is no longer
      // anything to judge this item against. Running it could only produce a
      // verdict about a question nobody asked.
      console.warn(
        `plan item "${draft.intent}" has no "Expect:" line after editing — skipping it`,
      );
    }
    draft = null;
  };

  let inPlan = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("### ")) {
      inPlan = true;
      continue;
    }
    if (!inPlan) continue;
    // The rule below the items separates the plan from the gate and footer.
    if (line.startsWith("---")) break;
    if (line.includes(RUN_TOKEN)) continue;

    const item = line.match(ITEM_RE);
    if (item?.[1] && item[2] && item[3]) {
      flush();
      draft = {
        checked: isChecked(item[1]),
        intent: item[2],
        route: item[3],
        steps: [],
        expected: "",
      };
      continue;
    }

    if (draft) {
      const step = line.match(STEP_RE);
      if (step?.[1]) {
        draft.steps.push(step[1]);
        continue;
      }
      const expected = line.match(EXPECT_RE);
      if (expected?.[1]) draft.expected = expected[1];
      continue;
    }

    // Anything before the first item is the summary, minus the parenthetical
    // confidence note we render on its own line.
    const text = line.trim();
    if (text && !text.startsWith("_(") && !text.startsWith("<sub>")) {
      summaryParts.push(text);
    }
  }
  flush();

  return {
    headSha,
    run,
    skipped,
    plan: { summary: summaryParts.join(" "), confidence, items },
  };
}

/**
 * The plan as it stands on the PR right now: human edits, unchecked items, and
 * the state of the gate. Null when the comment is gone (someone deleted it) or
 * no longer parses as ours.
 */
export async function readPlanComment(
  octokit: Octokit,
  job: PullRequestJob,
): Promise<ParsedPlanComment | null> {
  const existing = await findPlanComment(octokit, job);
  if (!existing) return null;
  const parsed = parsePlanBody(existing.body);
  return parsed ? { id: existing.id, ...parsed } : null;
}

function renderPlan(plan: TestPlan, headSha: string): string {
  const lines: string[] = ["### 🎄 Greenlight: what I'll verify", "", plan.summary];
  if (plan.confidence === "low") {
    lines.push("_(low confidence, inferred from the diff alone)_");
  }
  lines.push("");
  for (const item of plan.items) {
    lines.push(`- [x] **${item.intent}** (\`${item.route}\`)`);
    for (const [i, step] of item.steps.entries()) {
      lines.push(`  ${i + 1}. ${step}`);
    }
    lines.push("");
    lines.push(`  **Expect:** ${item.expected}`);
    lines.push("");
  }
  lines.push(
    "---",
    "",
    `- [x] **Run these checks** as soon as the preview is ready ${RUN_TOKEN}`,
    "",
    `<sub>Plan for \`${headSha.slice(0, 7)}\` · uncheck the box above to pause me while you edit this plan, check it again to run · uncheck any item to skip it · pushing a commit replaces this plan</sub>`,
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
 * Writes the plan to the PR, replacing whatever was there. Overwriting is the
 * point: this comment describes one commit, and this is a new one.
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

  const content =
    plan.items.length > 0
      ? renderPlan(plan, job.headSha)
      : renderNothingToTest(plan, job.headSha);
  const body = `<!-- greenlight:plan sha:${job.headSha} confidence:${plan.confidence} -->\n${content}`;

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
