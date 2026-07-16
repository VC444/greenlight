import type { getInstallationOctokit } from "./github.js";
import type { PullRequestJob } from "./queue.js";

type Octokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PrContext {
  title: string;
  body: string;
  commitMessages: string[];
  linkedIssue: { number: number; title: string; body: string } | null;
  changedFiles: ChangedFile[];
  /** Full head-revision contents of the most relevant changed files. */
  fileContents: Array<{ path: string; content: string }>;
  packageJson: string | null;
  /** True if any list was cut off by the caps below. */
  truncated: boolean;
}

// Budget caps so a huge PR can't blow up the prompt.
const MAX_CHANGED_FILES = 100;
const MAX_PATCH_CHARS_TOTAL = 60_000;
const MAX_COMMITS = 30;
const MAX_FILES_WITH_CONTENT = 8;
const MAX_CONTENT_CHARS_PER_FILE = 16_000;

const SKIP_CONTENT = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|pdf|min\.js|min\.css)$/i;

function findLinkedIssueNumber(body: string): number | null {
  const closing = body.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/i);
  const bare = body.match(/#(\d+)/);
  const match = closing?.[1] ?? bare?.[1];
  return match ? Number(match) : null;
}

async function fetchFileContent(
  octokit: Octokit,
  job: PullRequestJob,
  path: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: job.owner,
      repo: job.repo,
      path,
      ref: job.headSha,
    });
    if (Array.isArray(data) || !("content" in data) || data.type !== "file") return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null; // deleted files, submodules, oversized blobs — all fine to skip
  }
}

export async function gatherPrContext(octokit: Octokit, job: PullRequestJob): Promise<PrContext> {
  const common = { owner: job.owner, repo: job.repo, pull_number: job.prNumber };

  const [{ data: pr }, { data: files }, { data: commits }] = await Promise.all([
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", common),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/files", {
      ...common,
      per_page: MAX_CHANGED_FILES,
    }),
    octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
      ...common,
      per_page: MAX_COMMITS,
    }),
  ]);

  let truncated = pr.changed_files > files.length || pr.commits > commits.length;

  // Patches, under a total character budget.
  let patchBudget = MAX_PATCH_CHARS_TOTAL;
  const changedFiles: ChangedFile[] = files.map((f) => {
    const entry: ChangedFile = {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    };
    if (f.patch && f.patch.length <= patchBudget) {
      entry.patch = f.patch;
      patchBudget -= f.patch.length;
    } else if (f.patch) {
      truncated = true;
    }
    return entry;
  });

  // Linked issue, if the body references one.
  const body = pr.body ?? "";
  let linkedIssue: PrContext["linkedIssue"] = null;
  const issueNumber = findLinkedIssueNumber(body);
  if (issueNumber && issueNumber !== job.prNumber) {
    try {
      const { data: issue } = await octokit.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}",
        { owner: job.owner, repo: job.repo, issue_number: issueNumber },
      );
      if (!issue.pull_request) {
        linkedIssue = { number: issue.number, title: issue.title, body: issue.body ?? "" };
      }
    } catch {
      // Issue may be in another repo or inaccessible — not worth failing over.
    }
  }

  // Full contents of the most-changed source files at the head revision, plus
  // package.json — enough surrounding context to understand routes/components.
  const contentCandidates = files
    .filter((f) => f.status !== "removed" && !SKIP_CONTENT.test(f.filename))
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, MAX_FILES_WITH_CONTENT);

  const fileContents: PrContext["fileContents"] = [];
  for (const f of contentCandidates) {
    const content = await fetchFileContent(octokit, job, f.filename);
    if (content === null) continue;
    if (content.length > MAX_CONTENT_CHARS_PER_FILE) {
      fileContents.push({
        path: f.filename,
        content: content.slice(0, MAX_CONTENT_CHARS_PER_FILE) + "\n… (truncated)",
      });
      truncated = true;
    } else {
      fileContents.push({ path: f.filename, content });
    }
  }

  const packageJson = await fetchFileContent(octokit, job, "package.json");

  return {
    title: pr.title,
    body,
    commitMessages: commits.map((c) => c.commit.message),
    linkedIssue,
    changedFiles,
    fileContents,
    packageJson,
    truncated,
  };
}
