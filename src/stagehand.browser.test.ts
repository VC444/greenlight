import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { Stagehand } from "@browserbasehq/stagehand";
import { SubscriptionLLMClient, type SubscriptionJsonRequest } from "./subscriptionCli.js";
import { SetupDecisionSchema, SetupExtractionSchema } from "./setup.js";
import { createNativeSetup } from "./nativeSetup.js";
import { runItem } from "./execute.js";
import { recorderInitScript, drainEvents } from "./recorder.js";
import { cacheProgress } from "./stagehandCache.js";

test("Stagehand caches actions across sessions and extracts conditions afresh", async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "greenlight-stagehand-test-"));
  let actionCalls = 0;
  let extractionCalls = 0;
  let mode: "action" | "extract" | "fact" = "action";
  let visible = true;
  const client = new SubscriptionLLMClient("codex", async <T>(_backend: unknown, request: SubscriptionJsonRequest) => {
    if (mode === "action") {
      actionCalls++;
      const elementId = request.prompt.match(/\[(\d+-\d+)\] button: Click me/)?.[1];
      assert.ok(elementId, "Stagehand must supply the fixture button in its accessibility snapshot");
      return { action: { elementId, description: "Click me", method: "click", arguments: [] }, twoStep: false } as T;
    }
    extractionCalls++;
    const schema = request.schema as { properties?: Record<string, unknown> };
    if (Object.hasOwn(schema.properties ?? {}, "completed")) {
      return { completed: true, progress: "Observed fixture" } as T;
    }
    if (mode === "fact") return { value: visible ? "Demo" : null } as T;
    return {
      status: visible ? "satisfied" : "unsatisfied", reason: "Fixture model response",
    } as T;
  });
  try {
    for (let session = 0; session < 2; session++) {
      const progress: string[] = [];
      const stagehand = new Stagehand({
        env: "LOCAL", disableAPI: true, disablePino: true, verbose: 2,
        logger: line => cacheProgress(line, message => progress.push(message)),
        cacheDir, llmClient: client,
        localBrowserLaunchOptions: { headless: true },
      });
      let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
      try {
        await stagehand.init();
        browser = await chromium.connectOverCDP(stagehand.connectURL());
        const page = browser.contexts()[0]!.pages()[0]!;
        await page.setContent('<button onclick="this.dataset.clicked=\'yes\'">Click me</button>');
        mode = "action";
        assert.equal((await stagehand.act("Click Click me", { page })).success, true);
        assert.equal(await page.getByRole("button").getAttribute("data-clicked"), "yes");
        assert.equal(actionCalls, 1, "The second session must replay the native action cache");
        assert.ok(progress.some(message => message.includes(session === 0 ? "cache MISS" : "cache HIT")));
        assert.ok((await readdir(cacheDir)).some(file => file.endsWith(".json")));

        mode = "extract";
        visible = session === 0;
        const before = extractionCalls;
        const result = await stagehand.extract("Is the button visible?", SetupDecisionSchema, { page });
        assert.ok(extractionCalls > before, "Conditions must call the model even with a warm cache");
        assert.equal(result.status, visible ? "satisfied" : "unsatisfied");
        mode = "fact";
        const fact = await stagehand.extract("Extract the selected workspace name.", SetupExtractionSchema, { page });
        assert.equal(fact.value, visible ? "Demo" : null);
        if (session === 0) {
          await page.route("https://preview.example/**", route => route.fulfill({
            contentType: "text/html", body: '<html><body><button onclick="this.textContent=\'Prepared\'">Prepare</button></body></html>',
          }));
          await page.addInitScript(recorderInitScript());
          const setup = createNativeSetup(`
            export default async function setup({ stagehand, page, z }) {
              const { value } = await stagehand.extract("Extract the selected workspace name.",
                z.object({ value: z.string().nullable() }), { page });
              if (value !== "Demo") throw new Error("Workspace missing");
              await page.getByRole("button", { name: "Prepare" }).click();
            }
          `);
          try {
            const evidence = await runItem(stagehand, page, "https://preview.example", {
              intent: "Verify native setup", route: "/", steps: [], expected: "Setup completes",
            }, null, undefined, setup, 5000, true);
            assert.equal(evidence.verdict, "pass", evidence.error ?? "");
            assert.equal(await page.getByRole("button").innerText(), "Prepared");
            const recording = await drainEvents(page);
            assert.ok(recording.length > 0, "The native setup must use the recorded browser page");
          } finally { await setup.dispose(); }
        }
      } finally {
        await browser?.close();
        await stagehand.close();
      }
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
});
