import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Octokit } from "@octokit/core";
import { readActionContext, readActionOptions } from "./actionContext.js";
import { applySetup, applyStartingState, parseSetup } from "./setup.js";
import { ActionTestPlanSchema, type TestPlan } from "./testplan.js";
import { parsePlanBody, renderPlan, readPlanComment, upsertPlanComment } from "./comment.js";
import { processJob } from "./pipeline.js";

const condition = { extract: "Extract the selected workspace name.", equals: "Demo" };
const importCondition = { extract: "Extract the import status.", equals: "Failed" };
const recipe = JSON.stringify({ version: 2, steps: [], ready: condition });
const plan: TestPlan = {
  summary: "Retry failed imports", confidence: "high", pmReview: { concerns: [], limitation: null },
  items: [{ intent: "Retry an import", route: "/imports", steps: [{ kind: "action", instruction: "Click Retry" }],
    expected: "Import succeeds", startingState: { steps: ["Open Sample import"], condition: importCondition }, blockedReason: null },
  { intent: "Retry as administrator", route: "/imports", steps: [], expected: "Import succeeds",
    startingState: null, blockedReason: "An administrator test account is missing." }],
};
const body = (value: TestPlan) => `<!-- greenlight:plan sha:abc confidence:high -->\n${renderPlan(value, "abc")}`;

const baseJob = { owner: "owner", repo: "repo", prNumber: 1, headSha: "b".repeat(40), baseSha: "a".repeat(40), action: "opened" as const };
const nativeSource = "export default async function setup() {}";
const contentClient = (content: string | Buffer, requests: unknown[] = []) => ({
  request: async (route: string, parameters: unknown) => {
    requests.push({ route, parameters });
    return { data: { type: "file", size: Buffer.byteLength(content), encoding: "base64", content: Buffer.from(content).toString("base64") } };
  },
}) as unknown as Octokit;

test("Action loads only the pinned PR head revision and validates setup input", async () => {
  const requests: any[] = [];
  const context = await readActionContext(contentClient(nativeSource, requests), baseJob, { GREENLIGHT_RUN_CONTEXT: "Use Sample import." });
  assert.equal(context.setup, nativeSource);
  assert.equal(context.notes, "Use Sample import.");
  assert.equal(context.conditionTimeoutMs, 60_000);
  assert.equal(requests[0].parameters.ref, baseJob.headSha);
  assert.equal(requests[0].parameters.path, ".greenlight/setup.ts");
  for (const headSha of ["", "main", "abc"]) {
    await assert.rejects(readActionContext(contentClient(nativeSource), { ...baseJob, headSha }), /pinned PR head SHA/);
  }
  assert.equal((await readActionContext(contentClient(nativeSource), { ...baseJob, baseSha: undefined }, {})).setup, nativeSource);
  for (const content of ["", "x".repeat(16_001), Buffer.from([0xff])]) {
    await assert.rejects(readActionContext(contentClient(content), baseJob, {}));
  }
  for (const seconds of ["0", "301", "1.5", "bad"]) {
    assert.throws(() => readActionOptions({ GREENLIGHT_SETUP_TIMEOUT_SECONDS: seconds }), /setup-timeout-seconds/);
  }
  assert.throws(() => readActionOptions({ GREENLIGHT_RUN_CONTEXT: "x".repeat(16_001) }), /run-context/);
});

test("setup added or changed in the PR is loaded without consulting the base", async () => {
  for (const baseSource of [null, "export default async function setup() { throw new Error('Old setup'); }"]) {
    const refs: string[] = [];
    const client = { request: async (_route: string, parameters: { ref: string }) => {
      refs.push(parameters.ref);
      const source = parameters.ref === baseJob.headSha ? nativeSource : baseSource;
      if (source === null) throw { status: 404 };
      return { data: { type: "file", size: Buffer.byteLength(source), encoding: "base64",
        content: Buffer.from(source).toString("base64") } };
    } } as unknown as Octokit;
    assert.equal((await readActionContext(client, baseJob, {})).setup, nativeSource);
    assert.deepEqual(refs, [baseJob.headSha]);
  }
});

test("missing PR head setup skips the hook, while API failures stop the run", async () => {
  for (const status of [404, 403, 500]) {
    const client = { request: async () => { throw { status }; } } as unknown as Octokit;
    if (status === 404) assert.equal((await readActionContext(client, baseJob, {})).setup, null);
    else await assert.rejects(readActionContext(client, baseJob, {}));
  }
});

test("Action schema requires prerequisite decisions without interactive questions", () => {
  const parsed = ActionTestPlanSchema.parse(plan);
  assert.equal("questions" in parsed, false);
  assert.equal(parsed.items[1]?.blockedReason, plan.items[1]?.blockedReason);
  assert.equal(ActionTestPlanSchema.safeParse({ ...plan, items: [{ ...plan.items[0], startingState: undefined }] }).success, false);
});

test("editable comments retain preparation, blockers, and typed test steps", () => {
  const edited = body(plan).replace("Open Sample import", "Open Another import");
  const parsed = parsePlanBody(edited)!;
  assert.deepEqual(parsed.plan.items[0]?.startingState, { steps: ["Open Another import"], condition: importCondition });
  assert.deepEqual(parsed.plan.items[0]?.steps, plan.items[0]?.steps);
  assert.equal(parsed.plan.items[1]?.blockedReason, plan.items[1]?.blockedReason);
  const unchecked = parsePlanBody(edited.replace("- [x] **Retry as administrator", "- [ ] **Retry as administrator"))!;
  assert.equal(unchecked.plan.items.length, 1);
  assert.equal(unchecked.skipped, 1);
  const broken = parsePlanBody(edited.replace("  **Ready:** Extract the import status.", ""))!;
  assert.match(broken.plan.items[0]?.blockedReason ?? "", /valid Ready and Equals/);
});

test("plan steps read as a plain numbered checklist and retain execution types after edits", () => {
  const steps: TestPlan["items"][number]["steps"] = [
    { kind: "action", instruction: "Click Retry" },
    { kind: "assert", instruction: "The import shows a success message." },
    "Open the import details",
  ];
  const rendered = body({ ...plan, items: [{ ...plan.items[0]!, steps }] });
  const visible = rendered.replace(/<!--.*?-->/g, "");
  assert.doesNotMatch(visible, /\[(?:action|assert)\]/);
  assert.match(visible, /1\.\s+Click Retry\s*\n  2\.\s+The import shows a success message\.\s*\n  3\. Open the import details/);
  const edited = rendered.replace("The import shows a success message.", "The import shows Complete.");
  assert.deepEqual(parsePlanBody(edited)?.plan.items[0]?.steps, [
    steps[0], { kind: "assert", instruction: "The import shows Complete." }, steps[2],
  ]);
});

test("CI setup bounds repeated unknown observations and stops before actions", async () => {
  let now = 0;
  const setup = JSON.stringify({ version: 2, steps: [{ id: "enter", wait_for: condition, actions: ["Click Continue"], verify: condition }], ready: condition });
  await assert.rejects(applySetup(setup, {
    inspect: async () => assert.fail("Must extract facts"),
    extract: async () => ({ value: null }),
    act: async () => assert.fail("Must not act before readiness"),
  }, undefined, { now: () => now, sleep: async ms => { now += ms; } }, 1000), /Setup blocked: enter wait_for: condition was not verified within 1000 ms/);
  assert.equal(now, 1000);
});

test("CI bounds hung and late successful observations, including starting-state readiness", async () => {
  await assert.rejects(applySetup(recipe, {
    inspect: async () => assert.fail("Must extract facts"), extract: () => new Promise(() => {}), act: async () => {},
  }, undefined, undefined, 10), /Setup blocked: ready: condition was not verified/);
  await assert.rejects(applyStartingState({ steps: [], condition: importCondition }, {
    inspect: async () => assert.fail("Must extract facts"), extract: () => new Promise(() => {}), act: async () => {},
  }, undefined, 10), /Prerequisite blocked: ready: condition was not verified/);
  let now = 0;
  await assert.rejects(applySetup(recipe, {
    inspect: async () => assert.fail("Must extract facts"),
    extract: async () => { now = 1001; return { value: "Demo" }; }, act: async () => {},
  }, undefined, { now: () => now, sleep: async () => {} }, 1000), /Setup blocked/);
});

test("Action pipeline passes setup to planning and execution through the editable comment", async () => {
  let comment = "";
  const client = { request: async (route: string, args: { body?: string }) => {
    if (route.startsWith("GET ")) return { data: comment ? [{ id: 1, body: comment }] : [] };
    comment = args.body!;
    return { data: {} };
  } } as unknown as Octokit;
  let executed = false;
  let reported = false;
  await processJob(client, { owner: "owner", repo: "repo", prNumber: 1, headSha: "abc", action: "opened" }, {
    readActionContext: async () => ({ mode: "action", setup: nativeSource, notes: "Use Sample import.", conditionTimeoutMs: 1000 }),
    gatherPrContext: async () => ({ changedFiles: [], commitMessages: [], linkedIssue: null } as never),
    generateTestPlan: async (_, context) => {
      assert.equal(context?.mode, "action");
      assert.equal(context?.setup, nativeSource);
      assert.equal(context?.notes, "Use Sample import.");
      return plan;
    },
    upsertPlanComment, readPlanComment,
    waitForPreview: async () => {
      comment = comment.replace("Open Sample import", "Open Another import");
      return { status: "ready", url: "https://preview.example" };
    },
    runPlan: async (_, current, __, setup, timeout) => {
      executed = true;
      assert.equal(typeof setup, "object");
      assert.equal(typeof setup === "object" && setup.kind, "native");
      assert.equal(timeout, 1000);
      assert.equal(current.items[0]?.startingState?.steps[0], "Open Another import");
      assert.equal(current.items[1]?.blockedReason, plan.items[1]?.blockedReason);
      return { items: [], replayUrl: null } as never;
    },
    reportResults: async () => { reported = true; },
  });
  assert.ok(executed && reported);
});

test("a CI readiness timeout is inconclusive and never exercises the changed behavior", async () => {
  const { runItem } = await import("./execute.js");
  const page = { on() {}, off() {}, goto: async () => {}, waitForLoadState: async () => {}, evaluate: async () => "ready" };
  const driver = {
    act: async () => assert.fail("No test actions may run"),
    extract: async () => new Promise(() => {}),
  };
  const item = { ...plan.items[0]!, startingState: { steps: [], condition: importCondition } };
  const prerequisite = await runItem(driver as never, page as never, "https://preview.example", item, null, undefined, undefined, 10);
  assert.equal(prerequisite.verdict, "uncertain");
  assert.match(prerequisite.error!, /^Prerequisite blocked:.*condition was not verified/);
  const setup = await runItem(driver as never, page as never, "https://preview.example", item, null, undefined, recipe, 10);
  assert.equal(setup.verdict, "uncertain");
  assert.match(setup.error!, /^Setup blocked:.*condition was not verified/);
});

test("Action manifest supplies all preparation inputs to the runtime", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const action = parse(await readFile(new URL("../action.yml", import.meta.url), "utf8"));
  const run = action.runs.steps.find((step: { name?: string }) => step.name === "Run Greenlight");
  for (const [input, env] of [["run-context", "GREENLIGHT_RUN_CONTEXT"], ["setup-timeout-seconds", "GREENLIGHT_SETUP_TIMEOUT_SECONDS"]]) {
    assert.ok(action.inputs[input!]);
    assert.equal(run.env[env!], "${{ inputs." + input + " }}");
  }
  assert.equal(action.inputs["setup-file"], undefined);
  assert.equal(run.env.GREENLIGHT_SETUP_FILE, undefined);
  assert.equal(action.inputs["setup-timeout-seconds"].default, "60");
});

test("version 2 compares extracted scalars exactly without sending expectations to the model", async () => {
  for (const expected of ["Demo", 0, false]) {
    const values = [null, typeof expected === "string" ? "demo" : String(expected), expected];
    const messages: string[] = [];
    let calls = 0;
    await applySetup(JSON.stringify({ version: 2, steps: [], ready: {
      extract: "Extract the requested page field.", equals: expected,
    } }), {
      inspect: async () => assert.fail("Must not ask for a readiness judgment"),
      extract: async prompt => {
        assert.match(prompt, /Extract the requested page field/);
        assert.ok(!prompt.includes(JSON.stringify(expected)), "Expected answer must not be sent to extraction");
        return { value: values[calls++]! };
      },
      act: async () => assert.fail("No actions configured"),
    }, message => messages.push(message), { sleep: async () => {} }, 1000);
    assert.equal(calls, 3);
    assert.ok(messages.some(message => message.includes("extracted null")));
    assert.ok(messages.some(message => message.includes(`verified. Expected ${JSON.stringify(expected)}, extracted ${JSON.stringify(expected)}`)));
  }
});

test("version 2 rejects ambiguous conditions before any browser action", () => {
  for (const ready of ["Workspace visible", { extract: "Extract title" },
    { extract: "", equals: "Demo" }, { extract: "Extract title", equals: null },
    { extract: "Extract title", equals: ["Demo"] }, { extract: "Extract title", equals: "Demo", contains: true }]) {
    assert.throws(() => parseSetup(JSON.stringify({ version: 2, steps: [], ready })));
  }
});

test("edited extraction comparisons retain types and malformed comparisons block execution", () => {
  for (const expected of ["Demo", 0, false]) {
    const edited = body(plan).replace('**Equals:** "Failed"', `**Equals:** ${JSON.stringify(expected)}`);
    assert.deepEqual(parsePlanBody(edited)?.plan.items[0]?.startingState?.condition,
      { extract: importCondition.extract, equals: expected });
  }
  for (const replacement of ["", "  **Equals:** null", "  **Equals:** Failed"]) {
    const edited = body(plan).replace('  **Equals:** "Failed"', replacement);
    assert.match(parsePlanBody(edited)?.plan.items[0]?.blockedReason ?? "", /valid Ready and Equals/);
  }
});

test("Stagehand extracts setup facts in order before test actions and judging", async () => {
  const { runItem } = await import("./execute.js");
  const events: string[] = [];
  const setup = JSON.stringify({ version: 2, steps: [{ id: "welcome",
    wait_for: { extract: "Extract the welcome dialog title.", equals: "Welcome" },
    actions: ["Click Continue"],
    verify: { extract: "Extract the number of visible welcome dialogs.", equals: 0 },
  }], ready: condition });
  const page = { on() {}, off() {}, goto: async () => {}, waitForLoadState: async () => {}, evaluate: async () => "ready" };
  const driver = {
    act: async (instruction: string) => { events.push(instruction); return { success: true }; },
    extract: async (prompt: string) => {
      if (prompt.includes("Extract: ")) {
        assert.ok(!prompt.includes("Demo"));
        const instruction = prompt.split("Extract: ")[1]!;
        events.push(instruction);
        return { value: instruction.includes("title") ? "Welcome" : instruction.includes("number") ? 0 : "Demo" };
      }
      events.push("judge");
      return { verdict: "pass", reasoning: "Expected result is present" };
    },
  };
  const result = await runItem(driver as never, page as never, "https://preview.example",
    { ...plan.items[0]!, startingState: null }, null, undefined, setup, 1000);
  assert.equal(result.verdict, "pass");
  assert.deepEqual(events, ["Extract the welcome dialog title.", "Click Continue",
    "Extract the number of visible welcome dialogs.", condition.extract, "Click Retry", "judge"]);
  assert.equal(result.stagehandCalls?.[0]?.schema, "SetupExtractionSchema");
});
