import { readSetup, SETUP_PATH } from "./setup.js";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { Octokit } from "@octokit/core";
import { gatherPrContext } from "./context.js";
import { runPlan } from "./execute.js";
import { renderNothingToTest } from "./comment.js";
import { renderResultsComment } from "./results.js";
import { generateTestPlan, type TestPlan } from "./testplan.js";
import type { PullRequestJob } from "./job.js";
import {
  subscriptionBackend,
  SubscriptionRequestError,
  validateSubscriptionAuth,
} from "./subscriptionCli.js";

const execFileAsync = promisify(execFile);

export const ACTION_PROMPT =
  "Want Greenlight on every PR? Set up the GitHub Action: " +
  "[https://github.com/VC444/greenlight#set-up-the-github-action]" +
  "(https://github.com/VC444/greenlight#set-up-the-github-action)";

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

export interface PullRequestTarget {
  hostname: string;
  owner: string;
  repo: string;
  number: number;
}

export interface SkillInput {
  pullRequest: PullRequestTarget;
  previewUrl: string;
}

type GitHubClient = Parameters<typeof gatherPrContext>[0];
type CommandRunner = (file: string, args: string[]) => Promise<string>;

export interface SkillDependencies {
  onProgress?: (message: string) => void;
  env: NodeJS.ProcessEnv;
  resolveToken: (hostname: string) => Promise<string>;
  createClient: (token: string, baseUrl: string) => GitHubClient;
  gatherContext: typeof gatherPrContext;
  readSetup: typeof readSetup;
  generatePlan: (
    context: Awaited<ReturnType<typeof gatherPrContext>>,
  ) => Promise<TestPlan | null>;
  executePlan: typeof runPlan;
  browserAvailable: () => Promise<boolean>;
  validateModel: (env: NodeJS.ProcessEnv) => Promise<void>;
}

async function runCommand(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, { encoding: "utf8" });
  return stdout;
}

export function parsePullRequestUrl(raw: string): PullRequestTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SkillError(
      `Invalid GitHub PR URL: "${raw}". Expected https://<github-host>/<owner>/<repo>/pull/<number>.`,
    );
  }

  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new SkillError(
      `Unsupported GitHub PR URL: "${raw}". Use https://<github-host>/<owner>/<repo>/pull/<number>.`,
    );
  }

  const match = url.pathname.match(
    /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)\/?$/,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new SkillError(
      `Invalid GitHub PR URL: "${raw}". Expected https://<github-host>/<owner>/<repo>/pull/<number>.`,
    );
  }

  return {
    hostname: url.hostname,
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  };
}

export function parsePreviewUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SkillError(
      `Invalid preview URL: "${raw}". Pass an absolute HTTP or HTTPS URL.`,
    );
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new SkillError(
      `Invalid preview URL: "${raw}". Pass an absolute HTTP or HTTPS URL without embedded credentials.`,
    );
  }
  return url.toString();
}

export function parseSkillInput(args: string[]): SkillInput {
  if (args.length !== 2 || !args[0] || !args[1]) {
    throw new SkillError(
      "Usage: greenlight <GitHub PR URL> <preview URL>",
    );
  }
  return {
    pullRequest: parsePullRequestUrl(args[0]),
    previewUrl: parsePreviewUrl(args[1]),
  };
}

function usesCloudTokens(hostname: string): boolean {
  return hostname === "github.com" || hostname.endsWith(".ghe.com");
}

export function gitHubApiUrl(hostname: string): string {
  if (hostname === "github.com") return "https://api.github.com";
  if (hostname.endsWith(".ghe.com")) return `https://api.${hostname}`;
  return `https://${hostname}/api/v3`;
}

export async function resolveGitHubToken(
  env: NodeJS.ProcessEnv = process.env,
  command: CommandRunner = runCommand,
  hostname = "github.com",
): Promise<string> {
  const fromEnvironment = usesCloudTokens(hostname)
    ? env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
    : env.GH_ENTERPRISE_TOKEN?.trim() || env.GITHUB_ENTERPRISE_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;

  try {
    const token = (
      await command("gh", ["auth", "token", "--hostname", hostname])
    ).trim();
    if (token) return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SkillError(
        `GitHub CLI was not found. Install \`gh\`, then run \`gh auth login -h ${hostname}\`.`,
      );
    }
    throw new SkillError(
      `GitHub CLI could not read a token. Run \`gh auth login -h ${hostname}\`. If \`gh auth status -h ${hostname}\` succeeds in your terminal, approve the agent host-access request so Greenlight can read the system keyring.`,
    );
  }

  throw new SkillError(
    `GitHub CLI returned no token. Run \`gh auth login -h ${hostname}\` and try again.`,
  );
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function browserAvailable(
  env: NodeJS.ProcessEnv = process.env,
  command: CommandRunner = runCommand,
): Promise<boolean> {
  const configured = env.CHROME_PATH?.trim();
  if (configured) return executable(configured);

  const knownPaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...(env.LOCALAPPDATA
      ? [`${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`]
      : []),
    ...(env.PROGRAMFILES
      ? [`${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`]
      : []),
  ];
  for (const path of knownPaths) {
    if (await executable(path)) return true;
  }

  const locator = process.platform === "win32" ? "where" : "which";
  for (const name of [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ]) {
    try {
      if ((await command(locator, [name])).trim()) return true;
    } catch {
      // Try the next conventional executable name.
    }
  }
  return false;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { status?: number }).status;
}

async function validateGitHubAccess(
  client: GitHubClient,
  target: PullRequestTarget,
): Promise<{ login: string; headSha: string }> {
  let login: string;
  try {
    const { data } = await client.request("GET /user");
    login = data.login;
  } catch {
    throw new SkillError(
      `GitHub authentication was rejected. Refresh ${usesCloudTokens(target.hostname) ? "GH_TOKEN or GITHUB_TOKEN" : "GH_ENTERPRISE_TOKEN or GITHUB_ENTERPRISE_TOKEN"}, or run \`gh auth login -h ${target.hostname}\`, then try again.`,
    );
  }

  try {
    await client.request("GET /repos/{owner}/{repo}", {
      owner: target.owner,
      repo: target.repo,
    });
  } catch (error) {
    const status = statusOf(error);
    if (status === 404) {
      throw new SkillError(
        `Repository ${target.owner}/${target.repo} was not found or @${login} cannot access it.`,
      );
    }
    if (status === 401 || status === 403) {
      throw new SkillError(
        `GitHub account @${login} cannot read repository ${target.owner}/${target.repo}.`,
      );
    }
    throw new SkillError(
      `Could not validate access to repository ${target.owner}/${target.repo}.`,
    );
  }

  try {
    const { data } = await client.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner: target.owner,
        repo: target.repo,
        pull_number: target.number,
      },
    );
    if (!data.head.sha) {
      throw new SkillError(
        `Pull request ${target.owner}/${target.repo}#${target.number} has no head commit.`,
      );
    }
    return { login, headSha: data.head.sha };
  } catch (error) {
    if (error instanceof SkillError) throw error;
    const status = statusOf(error);
    if (status === 404) {
      throw new SkillError(
        `Pull request ${target.owner}/${target.repo}#${target.number} was not found.`,
      );
    }
    if (status === 401 || status === 403) {
      throw new SkillError(
        `GitHub account @${login} cannot read pull request ${target.owner}/${target.repo}#${target.number}.`,
      );
    }
    throw new SkillError(
      `Could not read pull request ${target.owner}/${target.repo}#${target.number}.`,
    );
  }
}

async function validateModelSettings(env: NodeJS.ProcessEnv): Promise<void> {
  const localBackend = subscriptionBackend(env);
  if (!localBackend) {
    throw new SkillError(
      "Greenlight must be launched through its Codex or Claude Code skill.",
    );
  }
  try {
    await validateSubscriptionAuth(localBackend);
  } catch (error) {
    throw new SkillError(
      error instanceof Error
        ? error.message
        : `${localBackend} subscription authentication failed.`,
    );
  }
}

function appendActionPrompt(report: string): string {
  return `${report}\n\n---\n\n${ACTION_PROMPT}`;
}

const defaultDependencies: SkillDependencies = {
  env: process.env,
  resolveToken: (hostname) => resolveGitHubToken(process.env, runCommand, hostname),
  createClient: (token, baseUrl) =>
    new Octokit({ auth: token, baseUrl }) as unknown as GitHubClient,
  gatherContext: gatherPrContext,
  readSetup,
  generatePlan: generateTestPlan,
  executePlan: runPlan,
  browserAvailable: () => browserAvailable(),
  validateModel: validateModelSettings,
};

export async function runGreenlightSkill(
  args: string[],
  overrides: Partial<SkillDependencies> = {},
): Promise<string> {
  const input = parseSkillInput(args);
  const dependencies = { ...defaultDependencies, ...overrides };
  const progress = dependencies.onProgress;
  progress?.("Checking GitHub and model access...");
  const token = await dependencies.resolveToken(input.pullRequest.hostname);
  const client = dependencies.createClient(
    token,
    gitHubApiUrl(input.pullRequest.hostname),
  );
  const { headSha } = await validateGitHubAccess(client, input.pullRequest);
  await dependencies.validateModel(dependencies.env);

  const job: PullRequestJob = {
    owner: input.pullRequest.owner,
    repo: input.pullRequest.repo,
    prNumber: input.pullRequest.number,
    headSha,
    action: "synchronize",
  };

  let context: Awaited<ReturnType<typeof gatherPrContext>>;
  try {
    progress?.("Reading pull request changes...");
    context = await dependencies.gatherContext(client, job);
  } catch (error) {
    const status = statusOf(error);
    const detail =
      status === 401 || status === 403
        ? " Check repository read permissions."
        : "";
    throw new SkillError(
      `Could not gather pull request context for ${job.owner}/${job.repo}#${job.prNumber}.${detail}`,
    );
  }

  let plan: TestPlan | null;
  try {
    progress?.("Planning browser checks...");
    plan = await dependencies.generatePlan(context);
  } catch (error) {
    if (error instanceof SubscriptionRequestError) {
      throw new SkillError(`Could not generate the Greenlight test plan: ${error.message}`);
    }
    throw new SkillError(
      "Greenlight could not generate a test plan. Check the model settings and provider credentials.",
    );
  }
  if (!plan) {
    throw new SkillError(
      "Greenlight could not generate a test plan. Check the model settings and provider credentials.",
    );
  }

  progress?.(`Plan ready: ${plan.items.length} checks.`);
  if (plan.items.length === 0) {
    return appendActionPrompt(renderNothingToTest(plan, headSha));
  }

  progress?.(`Looking for ${SETUP_PATH}...`);
  let setup: string | null;
  try {
    setup = await dependencies.readSetup();
  } catch (error) {
    throw new SkillError(error instanceof Error ? error.message : "Could not load browser setup.");
  }
  if (setup) progress?.(`Loaded local setup from ${SETUP_PATH}.`);

  if (!(await dependencies.browserAvailable())) {
    throw new SkillError(
      "Chrome was not found. Install Google Chrome or set CHROME_PATH to an executable Chrome or Chromium binary.",
    );
  }

  let result: Awaited<ReturnType<typeof runPlan>>;
  try {
    result = await dependencies.executePlan(input.previewUrl, plan, progress, setup ?? undefined);
  } catch {
    throw new SkillError(
      "Greenlight could not start or complete the browser session. Check Chrome and the model settings.",
    );
  }
  if (!result) {
    throw new SkillError(
      "Greenlight could not start or complete the browser session. Check Chrome and the model settings.",
    );
  }

  return appendActionPrompt(
    renderResultsComment(plan, result, headSha, null, "local"),
  );
}
