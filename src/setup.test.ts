import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import type { Page } from "playwright-core";
import { applySetup, parseSetup, readSetup } from "./setup.js";
import { runGreenlightInit, saveSetup, INIT_QUESTION, type InitSession } from "./init.js";

const hook = `export default async function setup({ page }) {
  const ready = page.getByRole("navigation");
  const dialog = page.getByRole("dialog");
  await dialog.or(ready).first().waitFor({ state: "visible" });
  if (await dialog.isVisible()) {
    await page.getByRole("checkbox", { name: "Acknowledge" }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await ready.waitFor({ state: "visible" });
}`;

async function temporary(run: (home: string) => Promise<void>) {
  const home = await mkdtemp(path.join(os.tmpdir(), "greenlight-setup-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

function session(overrides: Partial<InitSession> = {}): InitSession {
  return {
    inspect: async () => ({ snapshot: "Welcome dialog", error: null }),
    run: async () => ({ snapshot: "Navigation visible", error: null }),
    repeat: async () => {}, close: async () => {}, ...overrides,
  };
}

function draftGenerator() {
  let generated = false;
  return async () => {
    if (generated) return { code: null, complete: true, blocked: null };
    generated = true;
    return { code: hook, complete: false, blocked: null };
  };
}

test("only the local Playwright hook loads; malformed files fail closed", async () => temporary(async home => {
  assert.equal(await readSetup(home), null);
  await mkdir(path.join(home, ".greenlight"));
  const file = path.join(home, ".greenlight/setup.ts");
  await writeFile(file, hook);
  assert.equal(await readSetup(home), hook);
  for (const value of ["", "x".repeat(8001), Buffer.from([255]), "version: 1"]) {
    await writeFile(file, value);
    await assert.rejects(readSetup(home), /setup.ts/);
  }
  await rm(file);
  await mkdir(file);
  await assert.rejects(readSetup(home), /UTF-8 file/);
}));

test("legacy files require prompt-based migration and remain untouched", async () => temporary(async home => {
  await mkdir(path.join(home, ".greenlight"));
  for (const name of ["setup.yaml", "setup.md"]) {
    const file = path.join(home, ".greenlight", name);
    await writeFile(file, "old instructions");
    await assert.rejects(readSetup(home), /Legacy.*greenlight init/);
    assert.equal(await readSetup(home, true), null);
    assert.equal(await readFile(file, "utf8"), "old instructions");
    await rm(file);
  }
}));

test("hooks cannot import, access Node, evaluate page code, or leave background actions", () => {
  for (const body of [
    'await import("node:fs");', 'process.exit();', 'while (true) {}',
    'await page.evaluate("alert(1)");', 'await page.goto("https://other.example");',
    'await page.context().clearCookies();', 'await page["getByRole"]("button").click();',
    'const x = page.constructor;', 'page.getByRole("button").click();',
    'const x = page.getByRole("button").click();',
    'await page.getByRole("button", { get name() { return "X"; } }).click();',
    'await page.getByRole("button", { name: (() => "X")() }).click();',
    'await page.getByRole("button", { __proto__: null }).click();',
    'try { await page.getByRole("button").click(); } catch {}',
  ]) assert.throws(() => parseSetup(`export default async function setup({ page }) { ${body} }`), /setup.ts/);
  assert.throws(() => parseSetup(hook + '\nconsole.log("extra");'), /setup.ts/);
  assert.throws(() => parseSetup(hook.replace("{ page }", "{ page = process }")), /setup.ts/);
  assert.equal(typeof parseSetup(hook), "function");
});

test("Playwright setup awaits actions and readiness, including an already prepared page", async () => {
  const events: string[] = [];
  let prepared = false;
  const ready = { waitFor: async () => { events.push("ready"); assert.equal(prepared, true); } };
  const dialog = {
    or: () => ({ first: () => ({ waitFor: async () => { events.push("prerequisite"); } }) }),
    isVisible: async () => !prepared,
  };
  const page = { getByRole: (role: string) => ({
    navigation: ready, dialog,
    checkbox: { check: async () => { events.push("check"); } },
    button: { click: async () => { events.push("click"); prepared = true; } },
  })[role] } as unknown as Page;
  await applySetup(hook, page);
  await applySetup(hook, page);
  assert.deepEqual(events, ["prerequisite", "check", "click", "ready", "prerequisite", "ready"]);
});

test("failure blocks subsequent actions; deadline closes the page to cancel pending work", async () => {
  let clicked = false;
  const failing = { getByRole: () => ({ check: async () => { throw new Error("secret detail"); }, click: async () => { clicked = true; } }) } as unknown as Page;
  const code = `export default async function setup({ page }) {
    await page.getByRole("checkbox").check();
    await page.getByRole("button").click();
  }`;
  await assert.rejects(applySetup(code, failing), error => {
    assert.match(String(error), /Setup blocked:/);
    assert.doesNotMatch(String(error), /secret detail/);
    return true;
  });
  assert.equal(clicked, false);
  let closed = false;
  const stalled = { getByRole: () => ({ check: () => new Promise(() => {}) }),
    close: async () => { closed = true; } } as unknown as Page;
  await assert.rejects(applySetup(code, stalled, undefined, 10), /Setup blocked:.*timed out/);
  assert.equal(closed, true);
});

test("init asks for instructions before opening a browser or calling the model", async () => {
  assert.equal(await runGreenlightInit(undefined, "", () => {}), INIT_QUESTION);
  assert.equal(await runGreenlightInit("https://preview.example", " ", () => {}, {
    openBrowser: async () => assert.fail("must not open"), generate: async () => assert.fail("must not infer"),
  }), INIT_QUESTION);
  for (const url of ["file:///tmp/app", "https://user:secret@preview.example"]) {
    await assert.rejects(runGreenlightInit(url, "Continue", () => {}), /Invalid preview URL/);
  }
});

test("init uses observed UI, verifies before saving, and applies follow-up instructions", async () => temporary(async home => {
  const events: string[] = [];
  const browser = session({
    run: async code => { assert.equal(code, hook); events.push("run"); return { snapshot: "Navigation visible", error: null }; },
    repeat: async () => { events.push("repeat"); assert.equal(await readSetup(home), null); },
    close: async () => { events.push("close"); },
  });
  let calls = 0;
  const report = await runGreenlightInit("https://preview.example", "Acknowledge and continue", () => {}, {
    homeDir: home, openBrowser: async url => { assert.equal(url, "https://preview.example/"); return browser; },
    generate: async input => {
      assert.equal(input.instructions, "Acknowledge and continue");
      assert.equal(input.existing, null);
      if (calls++ === 0) { assert.equal(input.observation.snapshot, "Welcome dialog"); return { code: hook, complete: false, blocked: null }; }
      assert.equal(input.candidate, hook);
      assert.equal(input.observation.snapshot, "Navigation visible");
      return { code: null, complete: true, blocked: null };
    },
  });
  assert.match(report, /verified and saved/);
  assert.equal(await readSetup(home), hook);
  assert.deepEqual(events, ["run", "repeat", "close"]);
  const updated = hook.replace('name: "Continue"', 'name: "Open console"');
  let count = 0;
  await runGreenlightInit("https://preview.example", "The button is now Open console", () => {}, {
    homeDir: home, openBrowser: async () => session(), generate: async input => {
      assert.equal(input.existing, hook);
      return count++ ? { code: null, complete: true, blocked: null } : { code: updated, complete: false, blocked: null };
    },
  });
  assert.equal(await readSetup(home), updated);
}));

test("failed, unverified, or non-repeatable candidates never overwrite saved setup", async () => temporary(async home => {
  await saveSetup(hook, null, home);
  for (const scenario of ["generation", "execution", "repeat", "premature", "blocked"]) {
    let closed = false;
    const generate = draftGenerator();
    await assert.rejects(runGreenlightInit("https://preview.example", "Change setup", () => {}, {
      homeDir: home,
      openBrowser: async () => session({
        run: async () => ({ snapshot: "Still loading", error: scenario === "execution" ? "failed" : null }),
        repeat: async () => { if (scenario === "repeat") throw new Error("not repeatable"); },
        close: async () => { closed = true; },
      }),
      generate: async () => {
        if (scenario === "generation") throw new Error("model unavailable");
        if (scenario === "premature") return { code: null, complete: true, blocked: null };
        if (scenario === "blocked") return { code: null, complete: false, blocked: "Which workspace?" };
        return generate();
      },
    }));
    assert.equal(await readSetup(home), hook);
    assert.equal(closed, true);
  }
  await assert.rejects(saveSetup(hook, null, home), /changed during init/);
  assert.equal(await readSetup(home), hook);
}));

test("init bounds generation and does not execute invalid code", async () => temporary(async home => {
  let count = 0;
  await assert.rejects(runGreenlightInit("https://preview.example", "Continue", () => {}, {
    homeDir: home, openBrowser: async () => session({ run: async () => assert.fail("invalid code executed") }),
    generate: async () => { count++; return { code: "bad code", complete: false, blocked: null }; },
  }), /six attempts/);
  assert.equal(count, 6);
  assert.equal(await readSetup(home), null);
}));

test("CLI init without a prompt asks a question and never calls the backend", () => {
  const result = spawnSync(process.execPath, ["bin/greenlight.mjs", "init", "https://preview.example"], {
    env: { ...process.env, GREENLIGHT_LOCAL_AGENT: "claude" }, encoding: "utf8", timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /What needs to happen/);
  assert.doesNotMatch(result.stderr, /\x1b/);
});

const browserTests = process.env.GREENLIGHT_BROWSER_TESTS === "1";

test("real Chrome verifies init and handles delayed dialogs, repeated setup, and reload", { skip: !browserTests }, async () => temporary(async home => {
  const { createServer } = await import("node:http");
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<body><script>
      function ready() { document.body.innerHTML = '<nav>Console</nav>'; }
      if (localStorage.getItem('ready')) ready();
      else setTimeout(() => {
        document.body.innerHTML = '<div role="dialog"><label><input type="checkbox">Acknowledge</label><button>Continue</button></div>';
        document.querySelector('button').onclick = () => {
          if (document.querySelector('input').checked) { localStorage.setItem('ready', '1'); ready(); }
        };
      }, 200);
    </script></body>`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    let count = 0;
    await runGreenlightInit(`http://127.0.0.1:${address.port}`, "Acknowledge and continue", () => {}, {
      homeDir: home,
      generate: async input => {
        if (count++ === 0) return { code: hook, complete: false, blocked: null };
        assert.equal(input.observation.error, null);
        assert.match(input.observation.snapshot, /navigation/);
        assert.doesNotMatch(input.observation.snapshot, /checkbox/);
        return { code: null, complete: true, blocked: null };
      },
    });
    assert.equal(await readSetup(home), hook);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));

test("real Stagehand and Playwright share the exact target page", { skip: !browserTests }, async () => {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  const { chromium } = await import("playwright-core");
  const { findSetupPage } = await import("./execute.js");
  const stagehand = new Stagehand({
    env: "LOCAL", disableAPI: true, verbose: 0, disablePino: true,
    model: { modelName: "openai/gpt-4o", apiKey: "unused-test-key" },
    localBrowserLaunchOptions: { headless: true },
  });
  try {
    await stagehand.init();
    const unrelated = stagehand.context.activePage()!;
    const target = await stagehand.context.newPage();
    const browser = await chromium.connectOverCDP(stagehand.connectURL());
    const page = await findSetupPage(browser, target.targetId());
    await page.setContent('<button onclick="this.textContent=\'Ready\'">Continue</button>');
    await applySetup(`export default async function setup({ page }) {
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("button", { name: "Ready" }).waitFor();
    }`, page);
    assert.equal(await target.evaluate<string>('document.body.textContent'), "Ready");
    assert.notEqual(target.targetId(), unrelated.targetId());
    assert.notEqual(await unrelated.evaluate<string>('document.body.textContent'), "Ready");
    await assert.rejects(findSetupPage(browser, "missing"), /Setup blocked/);
  } finally { await stagehand.close(); }
});
