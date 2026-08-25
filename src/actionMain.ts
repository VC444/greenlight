import "./quiet.js";
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Octokit } from "@octokit/core";
import { processJob } from "./pipeline.js";
import type { PullRequestJob } from "./job.js";

/**
 * Entry point for the GitHub Action — the self-hosted path.
 *
 * A workflow run already has both the event (as a JSON file on disk) and an
 * authenticated token in the environment, so this reduces to: read the event,
 * build the job descriptor `processJob` wants, authenticate, and hand over.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} — this is set automatically inside a GitHub Actions run.`);
    process.exit(1);
  }
  return value;
}

interface PullRequestEvent {
  action?: string;
  pull_request?: { number: number; head: { sha: string } };
}

async function main(): Promise<void> {
  const event = JSON.parse(
    await readFile(required("GITHUB_EVENT_PATH"), "utf8"),
  ) as PullRequestEvent;

  const pr = event.pull_request;
  if (!pr) {
    console.log("not a pull_request event — nothing to do");
    return;
  }
  // Greenlight handles exactly these two; a workflow can be triggered on more
  // (reopened, labeled, …), so filter here rather than trusting the YAML.
  if (event.action !== "opened" && event.action !== "synchronize") {
    console.log(`pull_request.${event.action} is not handled — nothing to do`);
    return;
  }

  const repository = required("GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    console.error(`GITHUB_REPOSITORY is not owner/repo: ${repository}`);
    process.exit(1);
  }

  const job: PullRequestJob = {
    owner,
    repo,
    prNumber: pr.number,
    // NOT GITHUB_SHA: on pull_request that is the synthesized merge commit,
    // whereas the preview is deployed for the branch head. Looking up
    // deployments by the merge commit finds none, and Greenlight would silently
    // do nothing on every PR.
    headSha: pr.head.sha,
    action: event.action,
  };

  const octokit = new Octokit({ auth: required("GITHUB_TOKEN") });
  await processJob(octokit, job);
}

main().catch((error) => {
  // A broken run is not a verdict. Greenlight never turns a pull request red —
  // its check run is only ever "success" or "neutral" — and failing the step
  // would do exactly that over an infrastructure problem. So log loudly and
  // exit clean.
  console.error("greenlight run failed:", error instanceof Error ? error.stack : error);
});
