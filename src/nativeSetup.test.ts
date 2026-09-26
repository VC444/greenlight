import assert from "node:assert/strict";
import test from "node:test";
import { createNativeSetup } from "./nativeSetup.js";
import { chromium } from "playwright-core";
import { Stagehand } from "@browserbasehq/stagehand";
import { config } from "./config.js";
import { runPlan, runItem } from "./execute.js";

function fixture() {
  const events: string[] = [];
  const page = { on() {}, off() {}, goto: async (url: string) => { events.push(`goto ${new URL(url).pathname}`); },
    getByRole: (_role: string, options: { name: string }) => ({ click: async () => { events.push(options.name); } }),
    waitForLoadState: async () => {}, evaluate: async () => "ready" };
  const stagehand = { act: async (instruction: string) => { events.push(instruction); return { success: true }; },
    extract: async () => ({ verdict: "pass", reasoning: "Result visible" }) };
  return { events, page, stagehand };
}
const item = { intent: "Check behavior", route: "/app", steps: ["Test action"], expected: "Expected result" };

test("native TypeScript loads once, resolves runtime dependencies, and receives the live session", async () => {
  const setup = createNativeSetup(`
    import { z } from "zod";
    import type { Page } from "playwright-core";
    let visits: number = 0;
    export default async function setup({ page, previewUrl, signal, ...extras }) {
      signal.throwIfAborted();
      z.string().url().parse(previewUrl);
      if (!page) throw new Error("Missing page");
      if (Object.keys(extras).length) throw new Error("Setup received extra capabilities");
      await page.getByRole("button", { name: "Setup visit " + ++visits }).click();
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
  const setup = createNativeSetup(`export default async function setup({ page }) {
    await page.getByRole("button", { name: "Prepare" }).click();
  }`);
  const { events, page, stagehand } = fixture();
  stagehand.extract = async () => assert.fail("Setup check must not judge with a model");
  try {
    const result = await runItem(null, page as never, "https://preview.example", item, null, undefined, setup, 2000, true);
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
    export default async function setup({ signal, page }) {
      if (++visits === 1) return;
      await new Promise(resolve => {
        signal.addEventListener("abort", () => { page.getByRole("button", { name: "aborted" }).click(); resolve(); }, { once: true });
      });
      signal.throwIfAborted();
      await page.getByRole("button", { name: "must not run" }).click();
    }`);
  const { events, page, stagehand } = fixture();
  const context = { page: page as never, previewUrl: "https://preview.example" };
  try {
    await setup.run(context, 2000);
    await assert.rejects(setup.run(context, 20), /Native setup exceeded/);
    assert.equal(setup.timedOut, true);
    assert.deepEqual(events, ["aborted"]);
    await assert.rejects(setup.run(context, 2000), /session has ended/);
  } finally { await setup.dispose(); }
});

test("standalone setup launches Playwright without initializing Stagehand or requiring a model", async (t) => {
  const setup = createNativeSetup(`export default async function setup({ page }) {
    await page.getByRole("button", { name: "Prepare" }).click();
  }`);
  const { events, page } = fixture();
  const livePage = { ...page, setViewportSize: async () => {}, addInitScript: async () => {} };
  const context = { pages: () => [livePage] };
  const browser = { contexts: () => [], newContext: async () => context,
    close: async () => { events.push("closed"); } };
  t.mock.method(chromium, "launch", async (options: { channel: string }) => {
    assert.equal(options.channel, "chrome");
    return browser;
  });
  t.mock.method(Stagehand.prototype, "init", async () => assert.fail("Setup must not initialize Stagehand"));
  const previous = { localBrowser: config.localBrowser, replayDir: config.replayDir };
  config.localBrowser = true;
  config.replayDir = "";
  try {
    const result = await runPlan("https://preview.example", {
      summary: "Setup", confidence: "high", items: [item],
    }, undefined, setup, 2000, true);
    assert.equal(result?.items[0]?.verdict, "pass");
    assert.deepEqual(events, ["goto /", "Prepare", "closed"]);
  } finally {
    Object.assign(config, previous);
    await setup.dispose();
  }
});

test("Stagehand PR actions observe state prepared by Playwright on the same page", async () => {
  const setup = createNativeSetup(`export default async function setup({ page }) {
    await page.getByRole("button", { name: "Prepare" }).click();
  }`);
  const { page, stagehand } = fixture();
  let prepared = false;
  page.getByRole = () => ({ click: async () => { prepared = true; } });
  let actions = 0;
  stagehand.act = async (_instruction: string, options?: { page: unknown }) => {
    assert.equal(prepared, true);
    assert.equal(options?.page, page);
    actions++;
    return { success: true };
  };
  try {
    const result = await runItem(stagehand as never, page as never, "https://preview.example",
      { ...item, route: "/" }, null, undefined, setup, 2000);
    assert.equal(result.verdict, "pass", result.error ?? "");
    assert.equal(actions, 1);
    assert.deepEqual(result.stagehandCalls?.map(call => call.method), ["act", "extract"]);
  } finally { await setup.dispose(); }
});
