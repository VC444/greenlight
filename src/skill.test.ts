import { applySetup, readSetup, parseSetup } from "./setup.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
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

test("skill runner isolates npm cache, cleans up on failure, and honors cache overrides", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "greenlight-cache-test-"));
  const fakeNpx = path.join(root, "npx");
  writeFileSync(fakeNpx, [
    "#!/usr/bin/env bash",
    'cache="${npm_config_cache:-${NPM_CONFIG_CACHE:-$HOME/.npm}}"',
    'mkdir -p "$cache/_cacache/tmp" "$cache/_logs" || exit 90',
    'probe=$(mktemp -d "$cache/_cacache/tmp/git-cloneXXXXXX") || exit 91',
    'rmdir "$probe"',
    'echo "$cache"',
    'exit "${NPX_EXIT_CODE:-0}"',
    "",
  ].join("\n"));
  chmodSync(fakeNpx, 0o755);
  // A file at the default cache path deterministically makes it unusable.
  writeFileSync(path.join(root, ".npm"), "unusable cache");
  const temp = path.join(root, "temporary files");
  mkdirSync(temp);
  const run = (extra: Record<string, string> = {}) => spawnSync("/bin/bash", [
    path.resolve("skills/greenlight/scripts/run-greenlight.sh"), "pr", "preview",
  ], {
    encoding: "utf8",
    env: {
      HOME: root, TMPDIR: temp, PATH: "/usr/bin:/bin",
      CODEX_SESSION_ID: "test-session",
      GREENLIGHT_NODE_PATH: process.execPath,
      GREENLIGHT_NPX_PATH: fakeNpx,
      ...extra,
    },
  });
  try {
    for (const code of [0, 42]) {
      const result = run({ NPX_EXIT_CODE: String(code) });
      assert.equal(result.status, code, result.stderr);
      const cache = result.stdout.trim();
      assert.equal(path.dirname(cache), temp);
      assert.match(path.basename(cache), /^greenlight-npm-/);
      assert.equal(existsSync(cache), false, "temporary cache must be cleaned up");
    }
    const silentFailure = run({ NPX_EXIT_CODE: "128" });
    assert.equal(silentFailure.status, 128);
    assert.match(silentFailure.stderr, /Greenlight: runtime could not start \(npx exit 128\)/);
    for (const key of ["npm_config_cache", "NPM_CONFIG_CACHE"]) {
      const cache = path.join(root, key);
      const result = run({ [key]: cache });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), cache);
      assert.equal(existsSync(cache), true, "user cache must be preserved");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill init prompts and saves without npx for Codex and Claude Code", async () => {
  const script = path.resolve("skills/greenlight/scripts/run-greenlight.sh");
  for (const hostEnv of [{ CODEX_SESSION_ID: "test-session" }, { CLAUDECODE: "1" }]) {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "greenlight-offline-init-"));
    const run = (...args: string[]) => spawnSync("/bin/bash", [script, "init", ...args], {
      encoding: "utf8",
      env: {
        HOME: homeDir,
        PATH: "/usr/bin:/bin",
        GREENLIGHT_NODE_PATH: process.execPath,
        GREENLIGHT_NPX_PATH: "/missing/npx",
        ...hostEnv,
      },
    });
    try {
      const prompt = run();
      assert.equal(prompt.status, 0, prompt.stderr);
      assert.match(prompt.stdout, /What steps should Greenlight follow/);
      const setupFile = path.join(homeDir, "input.json");
      writeFileSync(setupFile, '{"version":2}');
      const invalid = run("--setup-file", setupFile);
      assert.equal(invalid.status, 1);
      assert.equal(existsSync(path.join(homeDir, ".greenlight/setup.yaml")), false);
      writeFileSync(setupFile, JSON.stringify({ version: 1, steps: [], ready: {
        condition: "Console usable", timeout_ms: 10_000,
      } }));
      const saved = run("--setup-file", setupFile);
      assert.equal(saved.status, 0, saved.stderr);
      assert.match(saved.stdout, /Greenlight setup saved/);
      assert.equal((await readSetup(homeDir))?.includes("Console usable"), true);
      const repeat = run();
      assert.equal(repeat.status, 0, repeat.stderr);
      assert.match(repeat.stdout, /Kept your edits unchanged/);
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
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
    readSetup: async () => null,
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

test("Claude accepts Zod schemas without an unsupported dialect declaration", async () => {
  const schema = z.toJSONSchema(z.object({ answer: z.string(), $schema: z.string() }));
  const original = structuredClone(schema);
  const expected = { answer: "ok", $schema: "ordinary property" };
  const result = await runSubscriptionJson("claude", { prompt: "Answer", schema }, async (request) => {
    const supplied = JSON.parse(request.args[request.args.indexOf("--json-schema") + 1]!);
    if (supplied.$schema) {
      return { code: 1, stdout: "", stderr: 'Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"' };
    }
    const { $schema: dialect, ...constraints } = original;
    assert.ok(dialect);
    assert.deepEqual(supplied, constraints);
    return { code: 0, stdout: JSON.stringify({ structured_output: expected }), stderr: "" };
  });
  assert.deepEqual(result, expected);
  assert.deepEqual(schema, original);
});

test("Claude gateway requests retain credentials and do not require subscription login", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "greenlight-gateway-"));
  try {
    const cli = path.join(directory, "claude");
    writeFileSync(cli, `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  const valid = process.argv.includes("-p") &&
    process.env.ANTHROPIC_BASE_URL === "https://gateway.example" &&
    (process.env.ANTHROPIC_AUTH_TOKEN === "synthetic-token" ||
      process.env.ANTHROPIC_API_KEY === "synthetic-key") &&
    process.env.ANTHROPIC_MODEL === "gateway-model" &&
    !process.env.CLAUDECODE && !process.env.CLAUDE_CODE_ENTRYPOINT;
  console.log(JSON.stringify(valid
    ? { structured_output: { ok: true } }
    : { is_error: true, result: "Missing gateway configuration" }));
  process.exitCode = valid ? 0 : 1;
});
`);
    chmodSync(cli, 0o755);
    const moduleUrl = new URL("./subscriptionCli.ts", import.meta.url).href;
    const script = `
      import assert from "node:assert/strict";
      import { validateSubscriptionAuth, runSubscriptionJson, runProcess } from ${JSON.stringify(moduleUrl)};
      await validateSubscriptionAuth("claude");
      assert.deepEqual(await runSubscriptionJson("claude", {
        prompt: "Synthetic gateway test", schema: { type: "object" },
      }), { ok: true });
      const otherChild = await runProcess({
        file: process.execPath, cwd: process.cwd(),
        args: ["-e", "process.exitCode = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY ? 1 : 0"],
      });
      assert.equal(otherChild.code, 0);
      await assert.rejects(validateSubscriptionAuth("codex", async () => ({
        code: 1, stdout: "", stderr: "",
      })), /codex login/);
    `;
    for (const credentials of [
      { ANTHROPIC_AUTH_TOKEN: "synthetic-token", ANTHROPIC_API_KEY: undefined },
      { ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: "synthetic-key" },
    ]) {
      const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        encoding: "utf8", timeout: 10000,
        env: { ...process.env, PATH: directory, ...credentials,
          ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_MODEL: "gateway-model",
          CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli",
        },
      });
      assert.equal(run.status, 0, run.stderr);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  const progress: string[] = [];
  let receivedPreview = "";
  let receivedPlan: TestPlan | undefined;
  const report = await runGreenlightSkill(
    [
      "https://github.com/VC444/greenlight/pull/42",
      "https://preview.example",
    ],
    dependencies(routes, {
      onProgress: (message) => progress.push(message),
      executePlan: async (previewUrl, generatedPlan, onProgress) => {
        onProgress?.("Check 1/1: pass.");
        receivedPreview = previewUrl;
        receivedPlan = generatedPlan;
        return {
          ...result,
          replayUrl: "/Users/developer/Desktop/Greenlight Run/replay.html",
        };
      },
    }),
  );

  assert.deepEqual(progress, [
    "Checking GitHub and model access...",
    "Reading pull request changes...",
    "Looking for ~/.greenlight/setup.yaml...",
    "Planning browser checks...",
    `Plan ready: ${plan.items.length} checks.`,
    "Check 1/1: pass.",
  ]);
  assert.doesNotMatch(report, /Reading pull request changes|Check 1\/1: pass/);
  assert.equal(receivedPreview, "https://preview.example/");
  assert.equal(receivedPlan, plan);
  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => route.startsWith("GET ")));
  assert.match(report, /### 🎄 Greenlight Results:/);
  assert.ok(report.includes(`\n\n${plan.summary}\n\n**1 passed**`));
  assert.match(report, /Ran against the preview for PR commit/);
  assert.doesNotMatch(report, /Vercel/);
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
  const hostname = "github.example.com";
  const url = `https://${hostname}/owner/repo/pull/1259`;
  assert.deepEqual(parsePullRequestUrl(url), {
    hostname, owner: "owner", repo: "repo", number: 1259,
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
      assert.equal(job.owner, "owner");
      assert.equal(job.repo, "repo");
      assert.equal(job.prNumber, 1259);
      return context;
    },
  }));
  assert.ok(routes.length > 0);
  assert.ok(routes.every((route) => route.startsWith("GET ")));
});

test("Enterprise credentials never fall back to public GitHub tokens", async () => {
  const hostname = "github.example.com";
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
    assert.match((error as Error).message, /gh auth login -h github\.example\.com/);
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
    ["github.example.com", "https://github.example.com/api/v3"],
    ["example.ghe.com", "https://api.example.ghe.com"],
  ] as const) {
    urls.length = 0;
    const { createClient: _fakeClient, ...overrides } = dependencies([]);
    await runGreenlightSkill([
      `https://${hostname}/owner/repo/pull/1259`, "https://preview.example",
    ], overrides);
    assert.deepEqual(urls, [
      `${baseUrl}/user`,
      `${baseUrl}/repos/owner/repo`,
      `${baseUrl}/repos/owner/repo/pulls/1259`,
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


test("subscription failures report safe diagnostics instead of hiding the cause", async () => {
  const request = { prompt: "private PR text", schema: { type: "object" } };
  const cases = [
    { result: { code: 1, stdout: "", stderr: 'Error: --json-schema is not a valid JSON Schema: secret-token' }, expected: /Claude Code.*rejected.*JSON schema/ },
    { result: { code: 1, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in. Please run /login. secret-token" }), stderr: "" }, expected: /Claude Code.*authentication.*claude auth login/ },
    { result: { code: 0, stdout: JSON.stringify({ is_error: true, errors: ["Not logged in. secret-token"] }), stderr: "" }, expected: /Claude Code.*authentication.*claude auth login/ },
    { result: { code: 1, stdout: "", stderr: "Not logged in. secret-token" }, expected: /Claude Code.*authentication.*claude auth login/ },
    { result: { code: 1, stdout: "private PR text", stderr: "secret-token" }, expected: /Claude Code.*exit code 1/ },
    { result: { code: 0, stdout: "secret-token", stderr: "" }, expected: /Claude Code.*invalid JSON/ },
    { result: { code: 0, stdout: "{}", stderr: "" }, expected: /Claude Code.*no structured output/ },
    { result: { code: 0, stdout: JSON.stringify({ is_error: true, subtype: "error_max_structured_output_retries", errors: ["secret-token"], structured_output: { misleading: true } }), stderr: "" }, expected: /Claude Code.*structured output retry limit/ },
  ];
  for (const { result, expected } of cases) {
    await assert.rejects(runSubscriptionJson("claude", request, async () => result), (error: unknown) => {
      assert.match((error as Error).message, expected);
      assert.doesNotMatch((error as Error).message, /private PR text|secret-token/);
      return true;
    });
  }
});


test("safe subscription diagnostics survive the real planner and skill boundaries", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "greenlight-diagnostics-"));
  try {
    const cli = path.join(directory, "claude");
    writeFileSync(cli, `#!${process.execPath}
process.stdin.resume();
process.stdin.on("end", () => {
  console.error("secret-token and private PR text");
  process.exitCode = 7;
});
`);
    chmodSync(cli, 0o755);
    const skillUrl = new URL("./skill.ts", import.meta.url).href;
    const plannerUrl = new URL("./testplan.ts", import.meta.url).href;
    const script = `
      import { runGreenlightSkill } from ${JSON.stringify(skillUrl)};
      import { generateTestPlan } from ${JSON.stringify(plannerUrl)};
      try {
        await runGreenlightSkill(["https://github.com/example/repo/pull/1", "https://preview.example"], {
          resolveToken: async () => "synthetic-token",
          createClient: () => ({ request: async () => ({ data: { login: "tester", head: { sha: "abc" } } }) }),
          validateModel: async () => {},
          gatherContext: async () => (${JSON.stringify(context)}),
          generatePlan: generateTestPlan,
        });
        process.exitCode = 2;
      } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
      }
    `;
    const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 10000,
      env: { ...process.env, PATH: directory, GREENLIGHT_LOCAL_AGENT: "claude" },
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Could not generate the Greenlight test plan: Claude Code failed with exit code 7/);
    assert.doesNotMatch(run.stderr + run.stdout, /secret-token|private PR text|provider credentials/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model subprocess timeouts remain identifiable without raw output", async () => {
  await assert.rejects(runSubscriptionJson("claude", {
    prompt: "synthetic prompt", schema: { type: "object" },
  }, async () => runProcess({
    file: process.execPath, args: ["-e", "setTimeout(() => {}, 10000)"],
    cwd: os.tmpdir(), timeoutMs: 50,
  })), /Claude Code timed out/);
});

test("setup loads only the default local file and validates its contents", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "greenlight-setup-"));
  const folder = path.join(homeDir, ".greenlight");
  const file = path.join(folder, "setup.yaml");
  try {
    assert.equal(await readSetup(homeDir), null);
    mkdirSync(folder);
    const recipe = structuredSetup;
    writeFileSync(file, recipe);
    assert.equal(await readSetup(homeDir), recipe);
    for (const content of ["", "x".repeat(16001), Buffer.from([255])]) {
      writeFileSync(file, content);
      await assert.rejects(readSetup(homeDir), /setup.yaml/);
    }
    rmSync(file);
    mkdirSync(file);
    await assert.rejects(readSetup(homeDir), /must be a UTF-8 file/);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("skill loads local setup without a GitHub setup request or altering the test plan", async () => {
  let executed = false;
  const routes: string[] = [];
  await runGreenlightSkill(["https://github.com/owner/repo/pull/1", "https://preview.example"], dependencies(routes, {
    readSetup: async (...args) => {
      assert.equal(args.length, 0);
      return "Welcome setup";
    },
    executePlan: async (_url, actualPlan, _progress, setup) => {
      executed = true;
      assert.equal(actualPlan, plan);
      assert.equal(setup, "Welcome setup");
      return result;
    },
  }));
  assert.equal(executed, true);
  assert.ok(routes.every((route) => !route.includes("contents")));
  await assert.rejects(runGreenlightSkill(["https://github.com/owner/repo/pull/1", "https://preview.example"], dependencies([], {
    readSetup: async () => { throw new Error("Could not read setup"); },
    executePlan: async () => { assert.fail("must not run without the configured setup"); },
  })), /Could not read setup/);
});

const structuredSetup = JSON.stringify({
  version: 1,
  steps: [{ id: "welcome", wait_for: "Welcome visible",
    timeout_ms: 1000, actions: ["Ensure acknowledgment is checked", "Click Continue"], verify: "Welcome closed" }],
  ready: { condition: "Console usable", timeout_ms: 1000 },
});

test("setup waits for a delayed modal and resolves steps before checking readiness", async () => {
  const events: string[] = [];
  let welcomeInspections = 0;
  let time = 0;
  await applySetup(structuredSetup, {
    inspect: async (prompt) => {
      if (prompt.includes("Welcome visible")) {
        events.push("wait");
        return { status: ++welcomeInspections === 1 ? "unsatisfied" : "satisfied", reason: "Observed page" };
      }
      events.push(prompt.includes("Welcome closed") ? "verify" : "ready");
      return { status: "satisfied", reason: "Observed condition" };
    },
    act: async (action) => { events.push(action); },
  }, undefined, { now: () => time, sleep: async (ms) => { time += ms; } });
  assert.deepEqual(events, ["wait", "wait", "Ensure acknowledgment is checked", "Click Continue", "verify", "ready"]);
});

test("setup rejects skip conditions before inspecting or acting", async () => {
  for (const skip_if of ["Console usable", null]) {
    const setup = JSON.parse(structuredSetup);
    setup.steps[0].skip_if = skip_if;
    await assert.rejects(applySetup(JSON.stringify(setup), {
      inspect: async () => assert.fail("invalid setup must not inspect"),
      act: async () => assert.fail("invalid setup must not act"),
    }), /skip_if/);
  }
});

test("unresolved setup blocks the check on timeout, uncertainty, and failed verification", async () => {
  for (const phase of ["wait", "verify", "ready", "unknown", "action"]) {
    let time = 0;
    let checkStarted = false;
    const actions: string[] = [];
    await assert.rejects((async () => {
      await applySetup(structuredSetup, {
        inspect: async (prompt) => {
          if (phase === "unknown") return { status: "unknown", reason: "Cannot determine" };
          const failed = (phase === "wait" && prompt.includes("Welcome visible")) ||
            (phase === "verify" && prompt.includes("Welcome closed")) ||
            (phase === "ready" && prompt.includes('"Console usable"'));
          return { status: failed ? "unsatisfied" : "satisfied", reason: "Observed page" };
        },
        act: async (action) => { actions.push(action); if (phase === "action") throw new Error("Failed click"); },
      }, undefined, { now: () => time, sleep: async (ms) => { time += ms; } });
      checkStarted = true;
    })(), /Setup blocked:/);
    assert.equal(checkStarted, false);
    assert.equal(actions.length, phase === "wait" || phase === "unknown" ? 0 : phase === "action" ? 1 : 2);
  }
});

test("setup schema rejects ambiguity and reports field paths", () => {
  for (const [mutate, pattern] of [
    [(s: any) => { s.extra = true; }, /root/],
    [(s: any) => { s.version = 2; }, /version/],
    [(s: any) => { s.steps.push(s.steps[0]); }, /steps.1.id/],
    [(s: any) => { s.steps[0].timeout_ms = -1; }, /steps.0.timeout_ms/],
    [(s: any) => { s.steps[0].timeout_ms = "1000"; }, /steps.0.timeout_ms/],
    [(s: any) => { s.steps[0].actions = []; }, /steps.0.actions/],
    [(s: any) => { s.steps[0].verify = " "; }, /steps.0.verify/],
    [(s: any) => { s.steps[0].optional = true; }, /steps.0/],
    [(s: any) => { delete s.ready; }, /ready/],
  ] as const) {
    const setup = JSON.parse(structuredSetup);
    mutate(setup);
    assert.throws(() => parseSetup(JSON.stringify(setup)), pattern);
  }
  for (const content of ["version: 1\nversion: 1", "version: [", "---\nversion: 1\n---\nversion: 1", "a: &x {}\nb: *x"]) {
    assert.throws(() => parseSetup(content), /invalid YAML/);
  }
});

test("legacy setup blocks execution with migration guidance and remains untouched", async () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "greenlight-legacy-"));
  try {
    mkdirSync(path.join(homeDir, ".greenlight"));
    const legacy = path.join(homeDir, ".greenlight/setup.md");
    writeFileSync(legacy, "User instructions");
    await assert.rejects(readSetup(homeDir), /Legacy.*setup.md.*setup.yaml/);
    assert.equal(readFileSync(legacy, "utf8"), "User instructions");
    writeFileSync(path.join(homeDir, ".greenlight/setup.yaml"), structuredSetup);
    assert.equal(await readSetup(homeDir), structuredSetup);
    assert.equal(readFileSync(legacy, "utf8"), "User instructions");
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
});

test("required steps cannot be bypassed by an early global ready decision", async () => {
  const setup = JSON.parse(structuredSetup);
  await assert.rejects(applySetup(JSON.stringify(setup), {
    inspect: async () => ({ status: "ready", reason: "App looks ready" }) as never,
    act: async () => assert.fail("invalid decision must block"),
  }), /Setup blocked: welcome wait_for/);
});

test("required steps execute in order even when the app already looks ready", async () => {
  const setup = JSON.parse(structuredSetup);
  setup.steps.push({ id: "workspace", wait_for: "Workspace picker visible", timeout_ms: 1000,
    actions: ["Select saved workspace"], verify: "Workspace selected" });
  const events: string[] = [];
  await applySetup(JSON.stringify(setup), {
    inspect: async (prompt) => {
      events.push(JSON.parse(prompt.split("\nCondition: ")[1]!));
      return { status: "satisfied", reason: "Visible in current UI" };
    },
    act: async (action) => { events.push(action); },
  });
  assert.deepEqual(events, ["Welcome visible", "Ensure acknowledgment is checked", "Click Continue",
    "Welcome closed", "Workspace picker visible", "Select saved workspace", "Workspace selected", "Console usable"]);
});

test("stalled observations respect the configured deadline", async () => {
  const setup = JSON.stringify({ version: 1, steps: [], ready: { condition: "Console usable", timeout_ms: 10 } });
  await assert.rejects(applySetup(setup, {
    inspect: () => new Promise(() => {}),
    act: async () => assert.fail("no actions"),
  }), /Setup blocked: ready: observation timed out/);
});

test("init prompts without creating a file and saves supplied steps unchanged", async () => {
  const { runGreenlightInit, parseInitOptions } = await import("./init.js");
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "greenlight-init-"));
  try {
    assert.deepEqual(parseInitOptions([]), {});
    assert.deepEqual(parseInitOptions(["--setup-file", "recipe.yaml"]), { setupFile: "recipe.yaml" });
    for (const args of [["https://github.example.com/owner/repo"], ["--setup-file"], ["--force"]]) {
      assert.throws(() => parseInitOptions(args), /Usage/);
    }
    const prompt = await runGreenlightInit({ homeDir });
    assert.match(prompt, /What steps should Greenlight follow/);
    assert.equal(await readSetup(homeDir), null);
    const setupFile = path.join(homeDir, "supplied.yaml");
    writeFileSync(setupFile, structuredSetup);
    const report = await runGreenlightInit({ homeDir, setupFile });
    assert.match(report, /Saved your supplied steps/);
    assert.equal(await readSetup(homeDir), structuredSetup);
    writeFileSync(path.join(homeDir, ".greenlight/setup.yaml"), "# My personal edits\n" + structuredSetup);
    const repeat = await runGreenlightInit({ homeDir, setupFile: "nonexistent.yaml" });
    assert.match(repeat, /My personal edits/);
    assert.equal(await readSetup(homeDir), "# My personal edits\n" + structuredSetup);
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
});

test("init rejects invalid input without writing and refuses to overwrite a racing writer", async () => {
  const { runGreenlightInit, saveInitialSetup } = await import("./init.js");
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "greenlight-init-failure-"));
  try {
    const setupFile = path.join(homeDir, "supplied.yaml");
    for (const content of ["steps: []", "#".repeat(16001), Buffer.from([0xff])]) {
      writeFileSync(setupFile, content);
      await assert.rejects(runGreenlightInit({ homeDir, setupFile }));
      assert.equal(await readSetup(homeDir), null);
    }
    await saveInitialSetup("# First writer\n" + structuredSetup, homeDir);
    await assert.rejects(saveInitialSetup("# Second writer\n" + structuredSetup, homeDir), /EEXIST/);
    assert.equal(await readSetup(homeDir), "# First writer\n" + structuredSetup);
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
});

test("CLI init prompts, saves user input, and preserves existing setup", () => {
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "greenlight-init-cli-"));
  const run = (...args: string[]) => spawnSync(process.execPath, ["bin/greenlight.mjs", "init", ...args], {
    cwd: process.cwd(), env: { ...process.env, HOME: homeDir, GREENLIGHT_LOCAL_AGENT: "claude" },
    encoding: "utf8", timeout: 20_000,
  });
  try {
    const prompt = run();
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.match(prompt.stdout, /What steps should Greenlight follow/);
    const setupFile = path.join(homeDir, "supplied.yaml");
    writeFileSync(setupFile, "# My saved setup\n" + structuredSetup);
    const saved = run("--setup-file", setupFile);
    assert.equal(saved.status, 0, saved.stderr);
    assert.match(saved.stdout, /Saved your supplied steps/);
    const repeat = run();
    assert.equal(repeat.status, 0, repeat.stderr);
    assert.match(repeat.stdout, /My saved setup/);
    assert.match(repeat.stdout, /Kept your edits unchanged/);
  } finally { rmSync(homeDir, { recursive: true, force: true }); }
});

const pmReview = {
  concerns: [{
    concern: "Failed payments have no recovery action.",
    evidence: "The checkout change shows an error but removes the retry button.",
    impact: "Customers cannot complete their purchase after a temporary failure.",
    suggestion: "Keep a retry action that preserves the entered details.",
  }],
  limitation: "The linked acceptance criteria were not provided.",
};

test("local reports include grounded PM concerns without changing browser verdicts", async () => {
  const reviewedPlan = { ...plan, pmReview };
  const report = await runGreenlightSkill(
    ["https://github.example.com/owner/repo/pull/1", "https://preview.example"],
    dependencies([], { generatePlan: async () => reviewedPlan }),
  );
  assert.match(report, /#### PM perspective/);
  assert.match(report, /Based on PR context; not browser-verified/);
  for (const text of Object.values(pmReview.concerns[0]!)) assert.ok(report.includes(text));
  assert.ok(report.includes(pmReview.limitation));
  assert.match(report, /1 passed/);
});

test("PM review remains available when nothing is browser-testable", async () => {
  const { renderNothingToTest, parsePlanBody } = await import("./comment.js");
  const reviewedPlan = { ...plan, items: [], pmReview };
  const report = await runGreenlightSkill(
    ["https://github.example.com/owner/repo/pull/1", "https://preview.example"],
    dependencies([], {
      generatePlan: async () => reviewedPlan,
      browserAvailable: async () => assert.fail("no browser needed"),
    }),
  );
  assert.ok(report.includes(pmReview.concerns[0]!.concern));
  const body = "<!-- greenlight:plan sha:abc123 confidence:high -->\n" + renderNothingToTest(reviewedPlan, "abc123");
  assert.equal(parsePlanBody(body)?.plan.summary, plan.summary);
});

test("PM review distinguishes no concerns from unavailable review and caps concerns at eight", async () => {
  const { renderPmReview } = await import("./results.js");
  const { PmReviewSchema } = await import("./testplan.js");
  assert.match(renderPmReview({ ...plan, pmReview: { concerns: [], limitation: null } }), /No clear product concerns/);
  assert.match(renderPmReview(plan), /unavailable/);
  assert.doesNotMatch(renderPmReview(plan), /No clear product concerns/);
  const concerns = Array.from({ length: 8 }, (_, index) => ({
    ...pmReview.concerns[0]!, concern: `Product concern ${index + 1}`,
  }));
  const review = PmReviewSchema.parse({ ...pmReview, concerns });
  assert.equal(review.concerns.length, 8);
  assert.throws(() => PmReviewSchema.parse({ ...pmReview, concerns: [...concerns, concerns[0]] }));
  const rendered = renderPmReview({ ...plan, pmReview: review });
  for (const item of concerns) assert.ok(rendered.includes(item.concern));
  assert.throws(() => PmReviewSchema.parse({ ...pmReview, concerns: [{ ...pmReview.concerns[0], evidence: "" }] }));
});

test("GitHub results include the PM review without changing the check conclusion", async () => {
  const { reportResults } = await import("./results.js");
  const writes: Array<Record<string, any>> = [];
  const client = { request: async (route: string, params: Record<string, any>) => {
    if (route.includes("GET") && route.endsWith("check-runs")) return { data: { check_runs: [] } };
    if (route.includes("GET")) return { data: [] };
    writes.push(params);
    return { data: { html_url: "https://github.example.com/owner/repo/checks/1" } };
  } } as unknown as Parameters<typeof reportResults>[0];
  await reportResults(client, { owner: "owner", repo: "repo", prNumber: 1, headSha: "abc123", action: "synchronize" },
    { ...plan, pmReview }, result);
  assert.equal(writes[0]!.conclusion, "success");
  assert.ok(writes[0]!.output.text.includes(pmReview.concerns[0]!.concern));
  assert.ok(writes[1]!.body.includes(pmReview.concerns[0]!.concern));
});

test("missing prerequisites return questions before browser access and answers reach fresh planning", async () => {
  const args = ["https://github.com/owner/repo/pull/1", "https://preview.example"];
  let gathers = 0;
  let executions = 0;
  const question = "Which failed import should I use to check retry?";
  const overrides = dependencies([], {
    readSetup: async () => "Select test workspace",
    gatherContext: async () => { gathers++; return context; },
    generatePlan: async (_context, runContext) => {
      assert.equal(runContext?.setup, "Select test workspace");
      if (!runContext?.notes) return { ...plan, questions: [question] };
      assert.match(runContext.notes, /Sample import/);
      return { ...plan, questions: [] };
    },
    browserAvailable: async () => { assert.equal(gathers, 2); return true; },
    executePlan: async () => { executions++; return result; },
  });
  const response = await runGreenlightSkill(args, overrides);
  assert.ok(response.startsWith("[Greenlight input required]\n"));
  assert.deepEqual(JSON.parse(response.split("\n")[1]!).questions, [question]);
  assert.equal(executions, 0);
  const report = await runGreenlightSkill(args, { ...overrides, runNotes: `${question}\nUse Sample import.` });
  assert.equal(gathers, 2);
  assert.equal(executions, 1);
  assert.match(report, /1 passed/);
});

test("run-context option and file validation preserve notes without accepting invalid input", async () => {
  const { readRunNotes } = await import("./skillOptions.js");
  const directory = mkdtempSync(path.join(os.tmpdir(), "greenlight-notes-"));
  const file = path.join(directory, "context.txt");
  const args = ["https://github.com/owner/repo/pull/1", "https://preview.example"];
  try {
    assert.equal(await readRunNotes(), "");
    writeFileSync(file, "Use Sample import.\nRole: editor.");
    const options = parseLocalSkillOptions([...args, "--context-file", file, "--no-record"]);
    assert.deepEqual(options.args, args);
    assert.equal(options.replayDir, "");
    assert.equal(await readRunNotes(options.contextFile), "Use Sample import.\nRole: editor.");
    assert.equal(parseLocalSkillOptions([...args, `--context-file=${file}`]).contextFile, file);
    assert.throws(() => parseLocalSkillOptions([...args, "--context-file", "relative.txt"]), /absolute path/);
    assert.throws(() => parseLocalSkillOptions([...args, "--context-file"]), /absolute path/);
    assert.throws(() => parseLocalSkillOptions([...args, "--context-file", file, "--context-file", file]), /only once/);
    for (const value of [" ", Buffer.from([255]), "x".repeat(16001)]) {
      writeFileSync(file, value);
      await assert.rejects(readRunNotes(file), /--context-file/);
    }
    await assert.rejects(readRunNotes(path.join(directory, "missing")), /Could not read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("starting-state verification gates real item execution and leaves regressions to the judge", async () => {
  const { runItem } = await import("./execute.js");
  const events: string[] = [];
  const page = {
    on: () => {}, off: () => {},
    goto: async () => { events.push("navigate"); },
    waitForLoadState: async () => {}, evaluate: async () => "ready",
  };
  const item = {
    ...plan.items[0]!,
    startingState: { steps: ["Open Sample import"], condition: "Sample import has failed rows" },
  };
  let preparationSucceeds = true;
  let inspectionSucceeds = true;
  const driver = {
    act: async (step: string) => {
      events.push(step);
      return { success: preparationSucceeds };
    },
    extract: async (prompt: string) => {
      if (prompt.includes("Condition:")) {
        events.push("verify prerequisite");
        assert.match(prompt, /Sample import has failed rows/);
        if (!inspectionSucceeds) throw new Error("Cannot inspect prerequisite");
        return { status: "satisfied", reason: "Failed rows visible" };
      }
      events.push("judge behavior");
      return { verdict: "fail", reasoning: "The changed behavior is broken" };
    },
  };
  const check = () => runItem(driver as never, page as never, "https://preview.example", item, null);
  const verified = await check();
  assert.deepEqual(events, ["navigate", "Open Sample import", "verify prerequisite", ...item.steps, "judge behavior"]);
  assert.equal(verified.verdict, "fail");
  assert.equal(verified.error, null);

  events.length = 0;
  preparationSucceeds = false;
  const failedAction = await check();
  assert.equal(failedAction.verdict, "uncertain");
  assert.match(failedAction.error!, /^Prerequisite blocked:/);
  assert.deepEqual(events, ["navigate", "Open Sample import"]);

  events.length = 0;
  preparationSucceeds = true;
  inspectionSucceeds = false;
  const missing = await check();
  assert.equal(missing.verdict, "uncertain");
  assert.match(missing.error!, /^Prerequisite blocked:/);
  assert.deepEqual(events, ["navigate", "Open Sample import", "verify prerequisite"]);

  events.length = 0;
  const unavailable = await runItem(driver as never, page as never, "https://preview.example", {
    ...item, blockedReason: "No failed import is available; user asked to skip.",
  }, null);
  assert.equal(unavailable.verdict, "uncertain");
  assert.match(unavailable.error!, /No failed import is available/);
  assert.deepEqual(events, []);
});

test("local planner schema requires prerequisite decisions and targeted questions", async () => {
  const { LocalTestPlanSchema } = await import("./testplan.js");
  const local = {
    ...plan, pmReview: { concerns: [], limitation: null }, questions: [],
    items: plan.items.map(item => ({ ...item, startingState: null, blockedReason: null })),
  };
  assert.equal(LocalTestPlanSchema.safeParse(local).success, true);
  assert.equal(LocalTestPlanSchema.safeParse({ ...local, questions: undefined }).success, false);
  assert.equal(LocalTestPlanSchema.safeParse({ ...local, questions: ["a", "b", "c", "d"] }).success, false);
  assert.equal(LocalTestPlanSchema.safeParse({ ...local, items: plan.items }).success, false);
});

test("unavailable prerequisites produce a final inconclusive report without requiring Chrome", async () => {
  const report = await runGreenlightSkill(
    ["https://github.com/owner/repo/pull/1", "https://preview.example"],
    dependencies([], {
      runNotes: "No failed import available. Skip retry.",
      generatePlan: async () => ({
        ...plan, questions: [],
        items: plan.items.map(item => ({ ...item, blockedReason: "No failed import is available." })),
      }),
      browserAvailable: async () => { assert.fail("No browser needed for blocked checks"); },
      executePlan: async () => { assert.fail("Blocked checks must not execute"); },
    }),
  );
  assert.match(report, /1 inconclusive/);
  assert.match(report, /Prerequisite blocked: No failed import is available/);
});

test("real subscription planner carries run context and preserves the Action schema", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "greenlight-local-planner-"));
  try {
    const cli = path.join(directory, "claude");
    writeFileSync(cli, `#!${process.execPath}
let input = "";
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const schema = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  const local = Boolean(schema.properties.questions);
  const answered = input.includes("Use Sample import.");
  if (local && !input.includes("Select test workspace")) process.exit(8);
  const output = ${JSON.stringify({ ...plan, pmReview: { concerns: [], limitation: null } })};
  if (local) {
    output.questions = answered ? [] : ["Which failed import should I use?"];
    output.items = output.items.map(item => ({
      ...item, blockedReason: null,
      startingState: answered ? { steps: ["Open Sample import"], condition: "Failed rows visible" } : null,
    }));
  }
  console.log(JSON.stringify({ type: "result", subtype: "success", structured_output: output }));
});
`);
    chmodSync(cli, 0o755);
    const script = `
      import assert from "node:assert/strict";
      import { generateTestPlan } from ${JSON.stringify(new URL("./testplan.ts", import.meta.url).href)};
      const context = ${JSON.stringify(context)};
      const waiting = await generateTestPlan(context, { setup: "Select test workspace", notes: "" });
      assert.deepEqual(waiting.questions, ["Which failed import should I use?"]);
      const ready = await generateTestPlan(context, { setup: "Select test workspace", notes: "Use Sample import." });
      assert.deepEqual(ready.questions, []);
      assert.equal(ready.items[0].startingState.condition, "Failed rows visible");
      const action = await generateTestPlan(context);
      assert.equal(action.questions, undefined);
      assert.equal(action.items[0].startingState, undefined);
    `;
    const run = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      encoding: "utf8", timeout: 15000,
      env: { ...process.env, PATH: directory, GREENLIGHT_LOCAL_AGENT: "claude" },
    });
    assert.equal(run.status, 0, run.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
