import type { getInstallationOctokit } from "./github.js";
import type { PullRequestJob } from "./queue.js";
import { config } from "./config.js";

type Octokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

/**
 * Outcome of resolving the PR's Vercel preview.
 *  - ready:   the preview built and is serving; `url` is reachable.
 *  - failed:  Vercel reported the build as failed/errored — nothing to test.
 *  - timeout: a deployment exists but never went ready within the budget.
 *  - none:    no Vercel preview deployment for this SHA (repo not on Vercel,
 *             or the integration didn't fire). We stay silent, not red.
 */
export type PreviewResult =
  | { status: "ready"; url: string }
  | { status: "failed"; reason: string }
  | { status: "timeout" }
  | { status: "none" };

// Vercel drives previews through GitHub Deployments (the "Deployment" section
// on the PR), emitting deployment_status events pending → success/failure. We
// poll that rather than the Vercel REST API so we need no Vercel token and no
// extra scope — read access to Deployments is all it takes.
const POLL_INTERVAL_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Octokit's RequestError carries the HTTP status; a 403 here means the
// installation token can't read Deployments.
function isForbidden(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: number }).status === 403;
}

// GitHub deployment_status states that mean "stop waiting".
const READY_STATES = new Set(["success"]);
const FAILED_STATES = new Set(["failure", "error"]);

interface LatestStatus {
  state: string;
  url: string | null;
}

/**
 * The newest preview deployment for this SHA and its latest status. Vercel
 * creates one non-production (preview) deployment per push; if several exist
 * (e.g. a retried build) the most recent wins. Returns null until Vercel has
 * created the deployment — which can lag the pull_request event by seconds.
 */
async function latestPreviewStatus(
  octokit: Octokit,
  job: PullRequestJob,
): Promise<LatestStatus | null> {
  const { data: deployments } = await octokit.request(
    "GET /repos/{owner}/{repo}/deployments",
    { owner: job.owner, repo: job.repo, sha: job.headSha, per_page: 100 },
  );
  // Preview deployments only; GitHub returns newest first.
  const preview = deployments.find((d) => !d.production_environment);
  if (!preview) return null;

  const { data: statuses } = await octokit.request(
    "GET /repos/{owner}/{repo}/deployments/{deployment_id}/statuses",
    { owner: job.owner, repo: job.repo, deployment_id: preview.id, per_page: 1 },
  );
  const latest = statuses[0];
  if (!latest) return { state: "pending", url: null };
  // environment_url is the live preview; target_url is a fallback (older Vercel
  // payloads populated only the latter).
  return { state: latest.state, url: latest.environment_url ?? latest.target_url ?? null };
}

/**
 * Appends Vercel's protection-bypass params so an automated client can reach a
 * preview guarded by Deployment Protection. No-op when no secret is configured
 * (public previews need nothing). set-bypass-cookie lets the follow-up browser
 * navigation inherit the bypass instead of carrying the secret on every URL.
 */
export function withBypass(url: string): string {
  if (!config.vercelBypassSecret) return url;
  const u = new URL(url);
  u.searchParams.set("x-vercel-protection-bypass", config.vercelBypassSecret);
  u.searchParams.set("x-vercel-set-bypass-cookie", "true");
  return u.toString();
}

/**
 * Waits for the PR's Vercel preview to go ready and returns its URL. Polls the
 * GitHub Deployments API until the preview reaches a terminal state or the
 * budget runs out. This wait is deliberate: Vercel's build time doubles as the
 * window in which a human can correct the test plan before we execute it.
 */
export async function waitForPreview(
  octokit: Octokit,
  job: PullRequestJob,
): Promise<PreviewResult> {
  const label = `${job.owner}/${job.repo}#${job.prNumber}`;
  const deadline = Date.now() + config.previewTimeoutMs;
  let sawDeployment = false;

  while (Date.now() < deadline) {
    let status: LatestStatus | null;
    try {
      status = await latestPreviewStatus(octokit, job);
    } catch (error) {
      // A 403 is a permission gap (the App lacks Deployments: Read), not a
      // transient hiccup — it will never recover, so bail immediately instead
      // of polling for the whole budget.
      if (isForbidden(error)) {
        console.warn(
          `preview poll for ${label} forbidden — the GitHub App needs "Deployments: Read". ` +
            `Grant it in the App's repository permissions and accept the update. Staying silent.`,
        );
        return { status: "none" };
      }
      // Transient API hiccup — log and keep polling; don't abandon a build.
      console.warn(
        `preview poll for ${label} failed, retrying:`,
        error instanceof Error ? error.message : error,
      );
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    if (status) {
      sawDeployment = true;
      if (READY_STATES.has(status.state)) {
        if (!status.url) {
          // Ready but no URL is a Vercel payload we can't act on — treat as none.
          console.warn(`preview for ${label} reported ready without a URL — staying silent`);
          return { status: "none" };
        }
        console.log(`preview for ${label} ready at ${status.url}`);
        return { status: "ready", url: status.url };
      }
      if (FAILED_STATES.has(status.state)) {
        return { status: "failed", reason: `Vercel build ${status.state}` };
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return sawDeployment ? { status: "timeout" } : { status: "none" };
}
