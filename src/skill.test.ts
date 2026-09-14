import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { gatherPrContext, type PrContext } from "./context.js";
import type { ExecutionResult } from "./execute.js";
import { parseLocalSkillOptions } from "./skillOptions.js";
import {
  runProcess,
  runSubscriptionJson,
  subscriptionBackend,
  SubscriptionLLMClient,
  validateSubscriptionAuth,
  type ProcessRunner,
  type SubscriptionBackend,
  type SubscriptionJsonRequest,
} from "./subscriptionCli.js";
import type { TestPlan } from "./testplan.js";
import {
  ACTION_PROMPT,
  SkillError,
  parsePreviewUrl,
  parsePullRequestUrl,
  parseSkillInput,
  resolveGitHubToken,
  runGreenlightSkill,
  type SkillDependencies,
} from "./skill.js";

const context: PrContext = {
  title: "Add checkout confirmation",
  body: "",
  commitMessages: ["Add checkout confirmation"],
  linkedIssue: null,
  changedFiles: [],
  fileContents: [],
  packageJson: null,
  truncated: false,
};

const plan: TestPlan = {
  summary: "The PR adds a checkout confirmation.",
  confidence: "high",
  items: [
    {
      intent: "Confirm a completed checkout",
      route: "/checkout",
      steps: ["Click the Confirm order button"],
      expected: "A confirmation message is visible",
    },
  ],
};

const result: ExecutionResult = {
  replayUrl: undefined,
  items: [
    {
      intent: plan.items[0]!.intent,
      route: plan.items[0]!.route,
      verdict: "pass",
      reasoning: "The confirmation message is visible.",
      consoleErrors: [],
      error: null,
    },
  ],
};

test("action prompt links to the Action setup section", () => {
  assert.equal(
    ACTION_PROMPT,
    "Want Greenlight on every PR? Set up the GitHub Action: " +
      "[https://github.com/VC444/greenlight#set-up-the-github-action]" +
      "(https://github.com/VC444/greenlight#set-up-the-github-action)",
  );
});

test("skill runner finds Node when the invoking PATH omits it", () => {
  const script = path.resolve(
    "skills/greenlight/scripts/run-greenlight.sh",
  );
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "greenlight-node-test-"));
  const nvmBin = path.join(
    fakeHome,
    ".nvm/versions/node/v22.0.0/bin",
  );
  const localBin = path.join(fakeHome, ".local/bin");
  mkdirSync(nvmBin, { recursive: true });
  mkdirSync(localBin, { recursive: true });
  symlinkSync(process.execPath, path.join(nvmBin, "node"));
  const fakeNpx = path.join(localBin, "npx");
  writeFileSync(
    fakeNpx,
    "#!/usr/bin/env bash\nnode -e 'const [major, minor] = process.versions.node.split(\".\").map(Number); process.exit(major > 22 || (major === 22 && minor >= 20) ? 0 : 1)'\n",
  );
  chmodSync(fakeNpx, 0o755);

  try {
    const run = spawnSync("/bin/bash", [script, "pr", "preview"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        CODEX_SESSION_ID: "test-session",
        HOME: fakeHome,
        PATH: "/usr/bin:/bin",
      },
    });

    assert.equal(run.status, 0, run.stderr);
    assert.doesNotMatch(run.stderr, /node: not found/);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("skill runner exposes companion CLI directories to Node", () => {
  const script = path.resolve(
    "skills/greenlight/scripts/run-greenlight.sh",
  );
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "greenlight-path-test-"));
  const localBin = path.join(fakeHome, ".local/bin");
  const fakeNode = path.join(fakeHome, "node");
  mkdirSync(localBin, { recursive: true });
  writeFileSync(
    fakeNode,
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "-e" ]]; then exit 0; fi',
      "for executable in gh codex claude; do",
      '  command -v "$executable" >/dev/null || exit 127',
      "done",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeNode, 0o755);
  for (const executable of ["gh", "codex", "claude"]) {
    const target = path.join(localBin, executable);
    writeFileSync(target, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(target, 0o755);
  }
  const fakeNpx = path.join(localBin, "npx");
  writeFileSync(
    fakeNpx,
    [
      "#!/usr/bin/env bash",
      "for executable in gh codex claude; do",
      '  command -v "$executable" >/dev/null || exit 127',
      "done",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(fakeNpx, 0o755);

  try {
    const run = spawnSync("/bin/bash", [script, "invalid", "invalid"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        CODEX_SESSION_ID: "test-session",
        GREENLIGHT_NODE_PATH: fakeNode,
        HOME: fakeHome,
        PATH: "/usr/bin:/bin",
      },
    });
    assert.equal(run.status, 0);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("skill runner binds to its current subscription CLI", () => {
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "greenlight-agent-test-"));
  const fakeNode = path.join(fakeHome, "node");
  const fakeNpx = path.join(fakeHome, "npx");
  writeFileSync(
    fakeNode,
    [
      "#!/usr/bin/env bash",
      'if [[ "$1" == "-e" ]]; then exit 0; fi',
      '[[ "$GREENLIGHT_LOCAL_AGENT" == "$EXPECTED_AGENT" ]]',
      "",
    ].join("\n"),
  );
  chmodSync(fakeNode, 0o755);
  writeFileSync(
    fakeNpx,
    [
      "#!/usr/bin/env bash",
      '[[ "$GREENLIGHT_LOCAL_AGENT" == "$EXPECTED_AGENT" ]] || exit 10',
      '[[ "$1" == "--yes" ]] || exit 11',
      '[[ "$2" == "--package" ]] || exit 12',
      '[[ "$3" == "github:VC444/greenlight#main" ]] || exit 13',
      '[[ "$4" == "greenlight" ]] || exit 14',
      '[[ "$5" == "pr" && "$6" == "preview" ]] || exit 15',
      "",
    ].join("\n"),
  );
  chmodSync(fakeNpx, 0o755);

  try {
    const script = path.resolve(
      "skills/greenlight/scripts/run-greenlight.sh",
    );
    for (const [expected, inherited, hostEnv] of [
      ["codex", "claude", { CODEX_SESSION_ID: "test-session" }],
      ["claude", "codex", { CLAUDECODE: "1" }],
    ] as const) {
      const run = spawnSync("/bin/bash", [script, "pr", "preview"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...hostEnv,
          GREENLIGHT_LOCAL_AGENT: inherited,
          GREENLIGHT_NODE_PATH: fakeNode,
          GREENLIGHT_NPX_PATH: fakeNpx,
          EXPECTED_AGENT: expected,
          HOME: fakeHome,
          PATH: "/usr/bin:/bin",
        },
      });
      assert.equal(run.status, 0, run.stderr);
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("skill runner rejects missing or ambiguous agent hosts", () => {
  const script = path.resolve(
    "skills/greenlight/scripts/run-greenlight.sh",
  );
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "greenlight-host-test-"));
  const fakeNode = path.join(fakeHome, "node");
  writeFileSync(fakeNode, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(fakeNode, 0o755);

  try {
    for (const hostEnv of [
      {},
      { CODEX_SESSION_ID: "test-session", CLAUDECODE: "1" },
    ]) {
      const run = spawnSync("/bin/bash", [script, "pr", "preview"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...hostEnv,
          GREENLIGHT_NODE_PATH: fakeNode,
          HOME: fakeHome,
          PATH: "/usr/bin:/bin",
        },
      });
      assert.equal(run.status, 1);
      assert.match(run.stderr, /inside a Codex or Claude Code session/);
    }
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("packaged runtime entrypoint launches the local skill", () => {
  const run = spawnSync(
    process.execPath,
    [path.resolve("bin/greenlight.mjs"), "invalid", "invalid"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, GREENLIGHT_LOCAL_AGENT: "codex" },
    },
  );

  assert.equal(run.status, 1);
  assert.match(run.stderr, /Invalid GitHub PR URL/);
});

function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error("request failed"), { status });
}

function fakeClient(
  routes: string[],
  failure?: { route: string; status: number },
): ReturnType<SkillDependencies["createClient"]> {
  return {
    request: async (route: string) => {
      routes.push(route);
      if (failure?.route === route) throw statusError(failure.status);
      if (route === "GET /user") return { data: { login: "octocat" } };
      if (route === "GET /repos/{owner}/{repo}") return { data: { id: 1 } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return { data: { head: { sha: "abcdef1234567890" } } };
      }
      throw new Error(`Unexpected route: ${route}`);
    },
  } as never;
}

function dependencies(
  routes: string[],
  overrides: Partial<SkillDependencies> = {},
): Partial<SkillDependencies> {
  return {
    env: { GREENLIGHT_LOCAL_AGENT: "codex" },
    resolveToken: async () => "github-secret",
    createClient: () => fakeClient(routes),
    gatherContext: async () => context,
    generatePlan: async () => plan,
    executePlan: async () => result,
    browserAvailable: async () => true,
    validateModel: async () => {},
    ...overrides,
  };
}

test("parses canonical GitHub PR URLs", () => {
  assert.deepEqual(
    parsePullRequestUrl("https://github.com/VC444/greenlight/pull/42"),
    { hostname: "github.com", owner: "VC444", repo: "greenlight", number: 42 },
  );
  assert.deepEqual(
    parsePullRequestUrl("https://github.com/VC444/greenlight/pull/42/"),
    { hostname: "github.com", owner: "VC444", repo: "greenlight", number: 42 },
  );
});

test("rejects malformed or unsupported GitHub PR URLs", () => {
  for (const value of [
    "not-a-url",
    "http://github.com/VC444/greenlight/pull/42",
    "https://user:secret@github.com/VC444/greenlight/pull/42",
    "https://github.com:8443/VC444/greenlight/pull/42",
    "https://github.com/VC444/greenlight/issues/42",
    "https://github.com/VC444/greenlight/pull/0",
    "https://github.com/VC444/greenlight/pull/42?diff=split",
  ]) {
    assert.throws(() => parsePullRequestUrl(value), SkillError);
  }
});

test("validates and normalizes preview URLs", () => {
  assert.equal(parsePreviewUrl("https://preview.example"), "https://preview.example/");
  assert.equal(parsePreviewUrl("http://localhost:3000/app"), "http://localhost:3000/app");
  assert.throws(() => parsePreviewUrl("preview.example"), SkillError);
  assert.throws(
    () => parsePreviewUrl("https://user:secret@preview.example"),
    /without embedded credentials/,
  );
});

test("requires exactly a PR URL and preview URL", () => {
  assert.throws(() => parseSkillInput([]), /Usage:/);
  assert.throws(
    () => parseSkillInput(["https://github.com/VC444/greenlight/pull/42"]),
    /Usage:/,
  );
});

test("records to a unique Desktop folder by default", () => {
  const options = parseLocalSkillOptions(
    [
      "--",
      "https://github.com/VC444/greenlight/pull/42",
      "https://preview.example",
    ],
    {
      homeDir: "/Users/developer",
      now: new Date("2026-09-10T12:34:56.789Z"),
    },
  );

  assert.deepEqual(options.args, [
    "https://github.com/VC444/greenlight/pull/42",
    "https://preview.example",
  ]);
  assert.equal(
    options.replayDir,
    "/Users/developer/Desktop/greenlight-replay-2026-09-10T12-34-56-789Z",
  );
});

test("supports opting out or choosing a replay directory", () => {
  assert.deepEqual(
    parseLocalSkillOptions([
      "--no-record",
      "https://github.com/VC444/greenlight/pull/42",
      "https://preview.example",
    ]),
    {
      args: [
        "https://github.com/VC444/greenlight/pull/42",
        "https://preview.example",
      ],
      replayDir: "",
    },
  );

  assert.equal(
    parseLocalSkillOptions([
      "https://github.com/VC444/greenlight/pull/42",
      "https://preview.example",
      "--record-dir=/tmp/greenlight-custom",
    ]).replayDir,
    "/tmp/greenlight-custom",
  );

});

test("rejects invalid local options", () => {
  assert.throws(
    () => parseLocalSkillOptions(["--record-dir", "relative/path"]),
    /absolute path/,
  );
  assert.throws(
    () =>
      parseLocalSkillOptions([
        "--no-record",
        "--record-dir",
        "/tmp/replay",
      ]),
    /cannot be used together/,
  );
  assert.throws(
    () => parseLocalSkillOptions(["--unknown"]),
    /Unknown option/,
  );
  assert.throws(
    () =>
      parseLocalSkillOptions([
        "--agent",
        "claude",
        "https://github.com/VC444/greenlight/pull/42",
        "https://preview.example",
      ]),
    /Unknown option/,
  );
  assert.throws(
    () => parseLocalSkillOptions(["--no-record"]),
    /Usage: greenlight \[--no-record/,
  );
});

test("selects only subscription CLIs for local backends", () => {
  assert.equal(subscriptionBackend({ GREENLIGHT_LOCAL_AGENT: "codex" }), "codex");
  assert.equal(subscriptionBackend({ GREENLIGHT_LOCAL_AGENT: "claude" }), "claude");
  assert.equal(subscriptionBackend({}), null);
  assert.throws(
    () => subscriptionBackend({ GREENLIGHT_LOCAL_AGENT: "api" }),
    /Expected codex or claude/,
  );
});

test("validates subscription CLI authentication without exposing credentials", async () => {
  const codexRunner: ProcessRunner = async (request) => {
    assert.equal(request.file, "codex");
    assert.deepEqual(request.args, ["login", "status"]);
    return {
      code: 0,
      stdout: "",
      stderr: "Logged in using ChatGPT\n",
    };
  };
  await validateSubscriptionAuth("codex", codexRunner);

  const claudeRunner: ProcessRunner = async (request) => {
    assert.equal(request.file, "claude");
    assert.deepEqual(request.args, ["auth", "status", "--json"]);
    return {
      code: 0,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
    };
  };
  await validateSubscriptionAuth("claude", claudeRunner);

  await assert.rejects(
    validateSubscriptionAuth("codex", async () => ({
      code: 1,
      stdout: "token-value",
      stderr: "another-secret",
    })),
    (error: unknown) => {
      assert.match((error as Error).message, /codex login/i);
      assert.doesNotMatch((error as Error).message, /token-value|secret/);
      return true;
    },
  );
});

test("runs structured Codex and Claude subscription requests", async () => {
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  const codexRunner: ProcessRunner = async (request) => {
    assert.equal(request.file, "codex");
    assert.ok(request.args.includes("--ephemeral"));
    assert.ok(request.args.includes("--output-schema"));
    assert.equal(request.input?.includes("Return only the JSON value"), true);
    const outputIndex = request.args.indexOf("--output-last-message");
    await writeFile(request.args[outputIndex + 1]!, '{"answer":"codex"}');
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.deepEqual(
    await runSubscriptionJson<{ answer: string }>(
      "codex",
      { prompt: "Answer", schema },
      codexRunner,
    ),
    { answer: "codex" },
  );

  const claudeRunner: ProcessRunner = async (request) => {
    assert.equal(request.file, "claude");
    assert.ok(request.args.includes("--safe-mode"));
    assert.ok(!request.args.includes("--restricted"));
    assert.equal(request.args[request.args.indexOf("--tools") + 1], "");
    assert.equal(request.args[request.args.indexOf("--permission-mode") + 1], "dontAsk");
    assert.ok(request.args.includes("--no-session-persistence"));
    return {
      code: 0,
      stdout: JSON.stringify({ structured_output: { answer: "claude" } }),
      stderr: "",
    };
  };
  assert.deepEqual(
    await runSubscriptionJson<{ answer: string }>(
      "claude",
      { prompt: "Answer", schema },
      claudeRunner,
    ),
    { answer: "claude" },
  );
});

test("adapts structured Stagehand calls to the subscription CLI", async () => {
  const schema = z.object({ action: z.string() });
  const query = async <T>(
    backend: SubscriptionBackend,
    request: SubscriptionJsonRequest,
  ): Promise<T> => {
    assert.equal(backend, "codex");
    assert.match(request.prompt, /USER:\nChoose an action/);
    return { action: "click" } as T;
  };
  const client = new SubscriptionLLMClient("codex", query);
  const response = await client.createChatCompletion<{ action: string }>({
    options: {
      messages: [{ role: "user", content: "Choose an action" }],
      response_model: { name: "Action", schema },
    },
    logger: () => {},
  });

  assert.deepEqual(response.data, { action: "click" });
});

test("resolves GitHub credentials in environment precedence order", async () => {
  const shouldNotRun = async (): Promise<string> => {
    throw new Error("gh should not run");
  };
  assert.equal(
    await resolveGitHubToken(
      { GH_TOKEN: " first ", GITHUB_TOKEN: "second" },
      shouldNotRun,
    ),
    "first",
  );
  assert.equal(
    await resolveGitHubToken(
      { GH_TOKEN: " ", GITHUB_TOKEN: " second " },
      shouldNotRun,
    ),
    "second",
  );
  assert.equal(
    await resolveGitHubToken({}, async (file, args) => {
      assert.equal(file, "gh");
      assert.deepEqual(args, ["auth", "token", "--hostname", "github.com"]);
      return " cli-token\n";
    }),
    "cli-token",
  );
});

test("reports missing GitHub credentials without leaking command errors", async () => {
  await assert.rejects(
    resolveGitHubToken({}, async () => {
      throw new Error("secret-token-from-stderr");
    }),
    (error: unknown) => {
      assert.match((error as Error).message, /gh auth login/);
      assert.match((error as Error).message, /host-access request/);
      assert.doesNotMatch((error as Error).message, /secret-token/);
      return true;
    },
  );

  await assert.rejects(
    resolveGitHubToken({}, async () => {
      throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
    }),
    /GitHub CLI was not found/,
  );
});

test("runs the existing planner and browser with GET-only GitHub access", async () => {
  const routes: string[] = [];
  let receivedPreview = "";
  let receivedPlan: TestPlan | undefined;
  const report = await runGreenlightSkill(
    [
      "https://github.com/VC444/greenlight/pull/42",
      "https://preview.example",
    ],
    dependencies(routes, {
      executePlan: async (previewUrl, generatedPlan) => {
        receivedPreview = previewUrl;
        receivedPlan = generatedPlan;
        return {
          ...result,
          replayUrl: "/Users/developer/Desktop/Greenlight Run/replay.html",
        };
      },
    }),
  );

  assert.equal(receivedPreview, "https://preview.example/");
  assert.equal(receivedPlan, plan);
  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => route.startsWith("GET ")));
  assert.match(report, /### 🎄 Greenlight Results:/);
  assert.match(report, /1 passed/);
  assert.match(report, /Greenlight reports locally/);
  assert.doesNotMatch(report, /<\/?sub>/);
  assert.match(
    report,
    /\[Watch the session replay\]\(<\/Users\/developer\/Desktop\/Greenlight Run\/replay\.html>\)/,
  );
  assert.ok(report.endsWith(ACTION_PROMPT));
});

test("the real context gatherer only performs GET requests", async () => {
  const routes: string[] = [];
  let gatheredTitle = "";
  const client = {
    request: async (route: string) => {
      routes.push(route);
      if (route === "GET /user") return { data: { login: "octocat" } };
      if (route === "GET /repos/{owner}/{repo}") return { data: { id: 1 } };
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
        return {
          data: {
            head: { sha: "abcdef1234567890" },
            title: "Read-only context",
            body: null,
            changed_files: 0,
            commits: 0,
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/files") {
        return { data: [] };
      }
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits") {
        return { data: [] };
      }
      if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
        throw statusError(404);
      }
      throw new Error(`Unexpected route: ${route}`);
    },
  } as never;

  await runGreenlightSkill(
    [
      "https://github.com/VC444/greenlight/pull/42",
      "https://preview.example",
    ],
    dependencies(routes, {
      createClient: () => client,
      gatherContext: gatherPrContext,
      generatePlan: async (gathered) => {
        gatheredTitle = gathered.title;
        return plan;
      },
    }),
  );

  assert.equal(gatheredTitle, "Read-only context");
  assert.ok(routes.every((route) => route.startsWith("GET ")));
});

test("renders an empty plan without starting Chrome", async () => {
  const routes: string[] = [];
  let browserChecked = false;
  let browserStarted = false;
  const report = await runGreenlightSkill(
    [
      "https://github.com/VC444/greenlight/pull/42",
      "https://preview.example",
    ],
    dependencies(routes, {
      generatePlan: async () => ({
        summary: "This change has no browser-testable surface.",
        confidence: "high",
        items: [],
      }),
      browserAvailable: async () => {
        browserChecked = true;
        return true;
      },
      executePlan: async () => {
        browserStarted = true;
        return result;
      },
    }),
  );

  assert.equal(browserChecked, false);
  assert.equal(browserStarted, false);
  assert.match(report, /Greenlight: nothing to verify/);
  assert.ok(report.endsWith(ACTION_PROMPT));
});

test("returns distinct authentication, repository, and PR errors", async () => {
  const input = [
    "https://github.com/VC444/greenlight/pull/42",
    "https://preview.example",
  ];

  await assert.rejects(
    runGreenlightSkill(
      input,
      dependencies([], {
        createClient: () => fakeClient([], { route: "GET /user", status: 401 }),
      }),
    ),
    /GitHub authentication was rejected/,
  );

  await assert.rejects(
    runGreenlightSkill(
      input,
      dependencies([], {
        createClient: () =>
          fakeClient([], { route: "GET /repos/{owner}/{repo}", status: 404 }),
      }),
    ),
    /Repository VC444\/greenlight was not found or @octocat cannot access it/,
  );

  await assert.rejects(
    runGreenlightSkill(
      input,
      dependencies([], {
        createClient: () =>
          fakeClient([], {
            route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
            status: 404,
          }),
      }),
    ),
    /Pull request VC444\/greenlight#42 was not found/,
  );
});

test("reports missing Chrome", async () => {
  const input = [
    "https://github.com/VC444/greenlight/pull/42",
    "https://preview.example",
  ];

  await assert.rejects(
    runGreenlightSkill(
      input,
      dependencies([], { browserAvailable: async () => false }),
    ),
    /Chrome was not found/,
  );
});

test("normalizes planner and browser runner failures", async () => {
  const input = [
    "https://github.com/VC444/greenlight/pull/42",
    "https://preview.example",
  ];

  await assert.rejects(
    runGreenlightSkill(
      input,
      dependencies([], {
        generatePlan: async () => {
          throw new Error("provider-secret");
        },
      }),
    ),
    (error: unknown) => {
      assert.match((error as Error).message, /could not generate a test plan/);
      assert.doesNotMatch((error as Error).message, /provider-secret/);
      return true;
    },
  );

  await assert.rejects(
    runGreenlightSkill(
      input,
      dependencies([], {
        executePlan: async () => {
          throw new Error("browser-internal-detail");
        },
      }),
    ),
    (error: unknown) => {
      assert.match((error as Error).message, /browser session/);
      assert.doesNotMatch((error as Error).message, /browser-internal-detail/);
      return true;
    },
  );
});


test("routes an Enterprise PR through host-specific authentication and API", async () => {
  const hostname = "github.infra.cloudera.com";
  const url = `https://${hostname}/AWC/awc-core/pull/1259`;
  assert.deepEqual(parsePullRequestUrl(url), {
    hostname, owner: "AWC", repo: "awc-core", number: 1259,
  });
  const routes: string[] = [];
  await runGreenlightSkill([url, "https://preview.example"], dependencies(routes, {
    resolveToken: async (host) => {
      assert.equal(host, hostname);
      return "enterprise-token";
    },
    createClient: (token, baseUrl) => {
      assert.equal(token, "enterprise-token");
      assert.equal(baseUrl, `https://${hostname}/api/v3`);
      return fakeClient(routes);
    },
    gatherContext: async (_client, job) => {
      assert.equal(job.owner, "AWC");
      assert.equal(job.repo, "awc-core");
      assert.equal(job.prNumber, 1259);
      return context;
    },
  }));
  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => route.startsWith("GET ")));
});

test("Enterprise credentials never fall back to public GitHub tokens", async () => {
  const hostname = "github.infra.cloudera.com";
  const env = { GH_TOKEN: "public-token", GITHUB_TOKEN: "public-fallback" };
  const command = async (file: string, args: string[]) => {
    assert.equal(file, "gh");
    assert.deepEqual(args, ["auth", "token", "--hostname", hostname]);
    return "enterprise-cli-token";
  };
  assert.equal(await resolveGitHubToken(env, command, hostname), "enterprise-cli-token");
  const shouldNotRun = async (): Promise<string> => { throw new Error("unexpected CLI"); };
  assert.equal(await resolveGitHubToken({ ...env, GH_ENTERPRISE_TOKEN: " first ", GITHUB_ENTERPRISE_TOKEN: "second" }, shouldNotRun, hostname), "first");
  assert.equal(await resolveGitHubToken({ ...env, GITHUB_ENTERPRISE_TOKEN: " second " }, shouldNotRun, hostname), "second");
  await assert.rejects(resolveGitHubToken(env, async () => { throw new Error("secret"); }, hostname), (error: unknown) => {
    assert.match((error as Error).message, /gh auth login -h github\.infra\.cloudera\.com/);
    assert.doesNotMatch((error as Error).message, /secret/);
    return true;
  });
});


test("the default client sends requests to the PR host's API", async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ login: "reviewer", head: { sha: "abc123" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  for (const [hostname, baseUrl] of [
    ["github.com", "https://api.github.com"],
    ["github.infra.cloudera.com", "https://github.infra.cloudera.com/api/v3"],
    ["example.ghe.com", "https://api.example.ghe.com"],
  ] as const) {
    urls.length = 0;
    const { createClient: _fakeClient, ...overrides } = dependencies([]);
    await runGreenlightSkill([
      `https://${hostname}/AWC/awc-core/pull/1259`, "https://preview.example",
    ], overrides);
    assert.deepEqual(urls, [
      `${baseUrl}/user`,
      `${baseUrl}/repos/AWC/awc-core`,
      `${baseUrl}/repos/AWC/awc-core/pulls/1259`,
    ]);
  }
});


test("an early subprocess exit preserves stderr instead of crashing on EPIPE", () => {
  const moduleUrl = new URL("./subscriptionCli.ts", import.meta.url).href;
  const script = `
    import { runProcess } from ${JSON.stringify(moduleUrl)};
    const result = await runProcess({
      file: process.execPath,
      args: ["-e", "console.error('unsupported option'); process.exit(1)"],
      cwd: process.cwd(),
      input: "x".repeat(2 * 1024 * 1024),
    });
    console.log(JSON.stringify(result));
  `;
  const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { code: 1, stdout: "", stderr: "unsupported option\n" });
});

test("subprocess input is delivered normally and spawn errors reject", async () => {
  const input = "prompt".repeat(50000);
  const result = await runProcess({
    file: process.execPath,
    args: ["-e", "let n = 0; process.stdin.on('data', c => n += c.length); process.stdin.on('end', () => console.log(n))"],
    cwd: os.tmpdir(), input,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), String(input.length));
  await assert.rejects(runProcess({ file: "/nonexistent/greenlight-cli", args: [], cwd: os.tmpdir(), input }), { code: "ENOENT" });
});
