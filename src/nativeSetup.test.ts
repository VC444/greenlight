import assert from "node:assert/strict";
import test from "node:test";
import { createNativeSetup } from "./nativeSetup.js";
import { runItem } from "./execute.js";

function fixture() {
  const events: string[] = [];
  const page = { on() {}, off() {}, goto: async (url: string) => { events.push(`goto ${new URL(url).pathname}`); },
    waitForLoadState: async () => {}, evaluate: async () => "ready" };
  const stagehand = { act: async (instruction: string) => { events.push(instruction); return { success: true }; },
    extract: async () => ({ verdict: "pass", reasoning: "Result visible" }) };
  return { events, page, stagehand };
}
const item = { intent: "Check behavior", route: "/app", steps: ["Test action"], expected: "Expected result" };

test("native TypeScript loads once, resolves runtime dependencies, and receives the live session", async () => {
  const setup = createNativeSetup(`
    import { z } from "zod";
    import type { Stagehand } from "@browserbasehq/stagehand";
    let visits: number = 0;
    export default async function setup({ stagehand, page, previewUrl, signal }) {
      signal.throwIfAborted();
      z.string().url().parse(previewUrl);
      if (!page) throw new Error("Missing page");
      await stagehand.act("Setup visit " + ++visits, { page });
    }
  `);
  const { events, page, stagehand } = fixture();
  try {
    for (let index = 0; index < 2; index++) {
      const result = await runItem(stagehand as never, page as never, "https://preview.example", item, null, undefined, setup, 2000);
      assert.equal(result.verdict, "pass", result.error ?? "");
    }
    assert.deepEqual(events, ["goto /", "Setup visit 1", "goto /app", "Test action",
      "goto /", "Setup visit 2", "goto /app", "Test action"]);
  } finally { await setup.dispose(); }
});

test("setup-check exercises only the hook without planning or a model judgment", async () => {
  const setup = createNativeSetup(`export default async function setup({ stagehand, page, z }) {
    z.literal("Demo").parse("Demo");
    await stagehand.act("Prepare", { page });
  }`);
  const { events, page, stagehand } = fixture();
  stagehand.extract = async () => assert.fail("Setup check must not judge with a model");
  try {
    const result = await runItem(stagehand as never, page as never, "https://preview.example", item, null, undefined, setup, 2000, true);
    assert.equal(result.verdict, "pass", result.error ?? "");
    assert.deepEqual(events, ["goto /", "Prepare"]);
  } finally { await setup.dispose(); }
});

test("syntax errors, missing exports, and hook errors block checks before test actions", async () => {
  for (const source of ["this is not typescript {}", "export const value = 1;",
    'export default async function setup() { throw new Error("Workspace not ready"); }']) {
    const setup = createNativeSetup(source);
    const { events, page, stagehand } = fixture();
    try {
      const result = await runItem(stagehand as never, page as never, "https://preview.example", item, null, undefined, setup, 2000);
      assert.equal(result.verdict, "uncertain");
      assert.match(result.error!, /^Setup blocked:/);
      assert.deepEqual(events, ["goto /"]);
    } finally { await setup.dispose(); }
  }
});

test("native deadline aborts pending setup and prohibits reuse of that session", async () => {
  const setup = createNativeSetup(`let visits = 0;
    export default async function setup({ signal, stagehand }) {
      if (++visits === 1) return;
      await new Promise(resolve => {
        signal.addEventListener("abort", () => { stagehand.act("aborted"); resolve(); }, { once: true });
      });
      signal.throwIfAborted();
      await stagehand.act("must not run");
    }`);
  const { events, page, stagehand } = fixture();
  const context = { page: page as never, stagehand: stagehand as never, previewUrl: "https://preview.example" };
  try {
    await setup.run(context, 2000);
    await assert.rejects(setup.run(context, 20), /Native setup exceeded/);
    assert.equal(setup.timedOut, true);
    assert.deepEqual(events, ["aborted"]);
    await assert.rejects(setup.run(context, 2000), /session has ended/);
  } finally { await setup.dispose(); }
});
