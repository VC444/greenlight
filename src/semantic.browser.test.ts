import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { applySetup } from "./setup.js";
import { createSemanticDriver, type BrowserDiagnostic } from "./semantic.js";

test("exact setup conditions use real browser accessibility and visibility", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const diagnostics: BrowserDiagnostic[] = [];
    const semantic = createSemanticDriver(page, entry => diagnostics.push(entry));
    await page.setContent(`
      <span id="name">See Examples</span>
      <a href="#examples" aria-label="Old label" aria-labelledby="name">Open</a>
      <button><img alt="Continue" src="data:," /></button>
      <label>Search<input value="Current query" /></label>
      <button>Delete</button><button>Delete</button>
      <div hidden><a href="#hidden">Hidden link</a></div>
      <input type="checkbox" aria-label="I agree" checked />
    `);
    for (const condition of [
      'The link labeled "See Examples" is visible.',
      'The button named "Continue" is visible.',
      'The field labeled "Search" is visible.',
      'The link labeled "Hidden link" is not visible.',
      'The text "Missing" is absent.',
    ]) {
      assert.equal((await semantic.inspect(condition))?.status, "satisfied", condition);
    }
    assert.equal((await semantic.inspect('The link labeled "Hidden link" is visible.'))?.status, "unsatisfied");
    assert.equal((await semantic.inspect('The button named "Delete" is visible.'))?.status, "satisfied");
    assert.equal(diagnostics.at(-1)?.visibleCount, 2);
    assert.equal(await semantic.inspect("The workspace is ready"), null);
    assert.equal(await page.locator("[data-greenlight-semantic-ref]").count(), 0);

    // The existing setup loop must wait for content that appears later.
    await page.setContent('<a href="#examples" hidden>See Examples</a>');
    const reveal = setTimeout(() => {
      void page.getByRole("link", { includeHidden: true }).evaluate(element => element.removeAttribute("hidden"));
    }, 100);
    try {
      await applySetup(JSON.stringify({ version: 1, steps: [], ready: {
        condition: 'The link labeled "See Examples" is visible.', timeout_ms: 3000,
      } }), {
        inspectSemantic: semantic.inspect,
        inspect: async () => assert.fail("Exact conditions must not call the model"),
        act: async () => assert.fail("No actions are required"),
      });
    } finally {
      clearTimeout(reveal);
    }
    assert.ok(diagnostics.some(entry => entry.outcome === "unsatisfied"));
    assert.equal(diagnostics.at(-1)?.outcome, "satisfied");
  } finally {
    await browser.close();
  }
});

test("Playwright conditions share Stagehand's browser and extraction page", async () => {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const stagehand = new Stagehand({
    env: "LOCAL", disableAPI: true, disablePino: true, verbose: 0,
    model: { modelName: "openai/gpt-4.1-mini", apiKey: "unused-test-key" },
    localBrowserLaunchOptions: { headless: true },
  });
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  try {
    await stagehand.init();
    browser = await chromium.connectOverCDP(stagehand.connectURL());
    const page = browser.contexts()[0]!.pages()[0]!;
    await page.setContent('<a href="#examples">See Examples</a>');
    const semantic = createSemanticDriver(page, () => {});
    assert.equal((await semantic.inspect('The link labeled "See Examples" is visible.'))?.status, "satisfied");
    // No prompt means raw accessibility extraction without a model request.
    const snapshot = await stagehand.extract({ page });
    assert.match(snapshot.pageText, /See Examples/);
  } finally {
    await browser?.close();
    await stagehand.close();
  }
});
