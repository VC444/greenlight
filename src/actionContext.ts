import type { Octokit } from "@octokit/core";
import type { PullRequestJob } from "./job.js";
import type { RunContext } from "./testplan.js";

export function readActionOptions(env: NodeJS.ProcessEnv = process.env) {
  const seconds = env.GREENLIGHT_SETUP_TIMEOUT_SECONDS?.trim() || "60";
  if (!/^\d+$/.test(seconds) || Number(seconds) < 1 || Number(seconds) > 300) {
    throw new Error("setup-timeout-seconds must be a whole number from 1 to 300.");
  }
  const notes = env.GREENLIGHT_RUN_CONTEXT?.trim() || "";
  if (Buffer.byteLength(notes) > 16_000) throw new Error("run-context must be at most 16000 UTF-8 bytes.");
  return { notes, conditionTimeoutMs: Number(seconds) * 1000 };
}

export async function readActionContext(
  octokit: Octokit, job: PullRequestJob, env: NodeJS.ProcessEnv = process.env,
): Promise<RunContext & { conditionTimeoutMs: number }> {
  const options = readActionOptions(env);
  if (!job.headSha || !/^[a-f0-9]{40}$/i.test(job.headSha)) {
    throw new Error("A pinned PR head SHA is required to load .greenlight/setup.ts.");
  }
  let setup: string | null = null;
  try {
    const { data } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: job.owner, repo: job.repo, path: ".greenlight/setup.ts", ref: job.headSha,
    });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data) ||
        data.encoding !== "base64" || data.size > 16_000) {
      throw new Error(".greenlight/setup.ts must be a UTF-8 file of at most 16000 bytes.");
    }
    const bytes = Buffer.from(data.content, "base64");
    if (bytes.length > 16_000) throw new Error(".greenlight/setup.ts exceeds 16000 bytes.");
    setup = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    if (!setup) throw new Error(".greenlight/setup.ts is empty.");
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  console.log(setup ? `Loaded .greenlight/setup.ts from PR head revision ${job.headSha.slice(0, 7)}.`
    : "No .greenlight/setup.ts at the PR head revision; common setup skipped.");
  return { mode: "action", setup, ...options };
}
