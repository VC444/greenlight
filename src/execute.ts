import "dotenv/config";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import type { TestPlan } from "./testplan.js";
import { withBypass } from "./preview.js";
import { config } from "./config.js";
import {
  drainEvents,
  isRecording,
  recorderInitScript,
  writeReplay,
  type ItemRecording,
} from "./recorder.js";

// Plan steps assume a desktop layout (the nav collapses under ~768px); use a
// comfortable desktop size so responsive UIs render their full-width state.
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT_MS = 30_000;

// GREENLIGHT_DEBUG=1: phase-by-phase timing logs for a browser run, plus
// Stagehand's own logging, to localize where a run stalls. Off in normal use —
// the output is far too noisy for CI logs.
const DEBUG = process.env.GREENLIGHT_DEBUG === "1";

function dbg(message: string): void {
  if (DEBUG) console.log(`    [debug +${process.uptime().toFixed(1)}s] ${message}`);
}

/** What the page looks like right now: readyState + image progress. Raced with
 *  a short timeout so a driver that queues evaluate behind page settling can't
 *  stall the probe — that timeout itself is the interesting signal. */
async function pageState(page: StagehandPage): Promise<string> {
  const probe = page.evaluate<string>(
    `(() => {
      const imgs = Array.from(document.images);
      const pending = imgs.filter((i) => !i.complete).length;
      return document.readyState + ", " + pending + "/" + imgs.length + " images pending";
    })()`,
  );
  return Promise.race([
    probe,
    new Promise<string>((resolve) =>
      setTimeout(() => resolve("EVALUATE BLOCKED >3s — driver is gating evaluate on page settle"), 3_000).unref(),
    ),
  ]);
}
// How long after DOM-ready to let images/assets finish before acting, so the
// session recording captures a fully rendered page. Grace period only — hitting
// it proceeds with whatever has loaded, it never fails the item.
const ASSET_SETTLE_MS = 30_000;

// Stagehand's act/extract reasoning runs on OUR Fireworks model, not the
// Browserbase Model Gateway (disableAPI keeps it all local). We let Stagehand
// build the provider itself from a "prefix/model" string (its own AI SDK stack)
// rather than injecting a model — injecting one crosses a version boundary
// (this app is on ai@7, Stagehand bundles ai@5) and breaks at runtime.
//
// The provider PREFIX matters: "openai/…" maps to @ai-sdk/openai, whose default
// hits OpenAI's *Responses* API — which Fireworks doesn't implement. "togetherai/…"
// maps to an OpenAI-*compatible* provider that hits /chat/completions and honors
// a custom baseURL — exactly what Fireworks serves.
const FIREWORKS_PROVIDER_PREFIX = "togetherai";
const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY ?? "";
// Must stay a kimi-family model: Stagehand only grammar-enforces its act/extract
// schemas for kimi/deepseek/glm (others free-guess the shape and fail Zod). Kept
// separate from the plan model (GREENLIGHT_MODEL) so that setting can't leak here.
const EXECUTOR_MODEL =
  process.env.GREENLIGHT_EXECUTOR_MODEL ||
  "accounts/fireworks/models/kimi-k2p7-code";

// A native alert/confirm/prompt over CDP FREEZES the page (Stagehand has no
// built-in dialog dismissal), which would deadlock act/extract until the session
// cap. Injected before any page script runs, this no-ops the dialog functions so
// they can never block. We don't capture or judge dialogs — just keep the page
// alive (alert-based expectations are out of scope for now).
const DIALOG_SUPPRESS = `
(() => {
  window.alert = () => undefined;
  window.confirm = () => true;
  window.prompt = () => "";
})();
`;

const JudgeSchema = z.object({
  verdict: z
    .enum(["pass", "fail", "cannot_tell"])
    .describe(
      '"pass" if the expected outcome is clearly present in the page\'s ' +
        'DOM/accessibility tree; "fail" if it is clearly contradicted there; ' +
        '"cannot_tell" if deciding would need something not in that tree — ' +
        "purely visual styling (e.g. a highlight/color with no aria/data state), " +
        "the browser URL, or a native dialog",
    ),
  reasoning: z
    .string()
    .describe("one sentence citing what on the page decided the verdict"),
});

/**
 * Result for one plan item. `verdict`:
 *  - "pass"/"fail" are real test judgments from the LLM judge.
 *  - "uncertain" means execution itself broke (navigation/act threw) — we never
 *    turn that into a red; callers stay silent on it.
 */
export interface ItemEvidence {
  intent: string;
  route: string;
  verdict: "pass" | "fail" | "uncertain";
  reasoning: string;
  consoleErrors: string[];
  error: string | null;
}

export interface ExecutionResult {
  sessionId: string | undefined;
  replayUrl: string | undefined;
  items: ItemEvidence[];
}

// In-process cap on concurrent Browserbase sessions. The free tier allows only
// a few at once; the while-loop re-checks after each wake so slots are never
// double-granted.
let activeSessions = 0;
const slotWaiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  while (activeSessions >= config.maxConcurrentSessions) {
    await new Promise<void>((resolve) => slotWaiters.push(resolve));
  }
  activeSessions++;
}

function releaseSlot(): void {
  activeSessions--;
  slotWaiters.shift()?.();
}

/** True when everything execution needs is configured: the LLM that drives +
 *  judges the steps (Fireworks), plus a browser. Local mode needs no Browserbase
 *  credentials; remote mode needs both the API key and project id. */
export function canExecute(): boolean {
  if (!FIREWORKS_API_KEY) return false;
  if (config.localBrowser) return true;
  return Boolean(config.browserbaseApiKey && config.browserbaseProjectId);
}

/**
 * Drives the PR's preview through the plan in a browser (a Browserbase cloud
 * session, or a local Chrome when config.localBrowser is set), acting on
 * natural-language steps with an LLM judge for each item's `expected`. Returns
 * per-item verdicts + evidence and the session replay URL, or null when
 * execution can't run at all (callers stay silent).
 *
 * Cloud sessions are opened late (only once we have a ready preview) and
 * lifetime-capped by browserbaseSessionCreateParams.timeout. Local runs have no
 * session id and therefore no replay URL.
 */
export async function runPlan(
  previewUrl: string,
  plan: TestPlan,
): Promise<ExecutionResult | null> {
  if (!canExecute()) {
    console.warn(
      "execution not configured (needs FIREWORKS_API_KEY plus either " +
        "GREENLIGHT_LOCAL_BROWSER=1 or BROWSERBASE_API_KEY + BROWSERBASE_PROJECT_ID) — skipping",
    );
    return null;
  }

  await acquireSlot();
  // Reason locally on our Fireworks model (disableAPI) — never route act/extract
  // through Browserbase's server-side API / Model Gateway. Browser location is
  // the only thing that differs between local and remote.
  const modelConfig = {
    disableAPI: true,
    verbose: (DEBUG ? 2 : 0) as 0 | 1 | 2,
    disablePino: true,
    model: {
      modelName: `${FIREWORKS_PROVIDER_PREFIX}/${EXECUTOR_MODEL}`,
      apiKey: FIREWORKS_API_KEY,
      baseURL: FIREWORKS_BASE_URL,
    },
  };
  const stagehand = config.localBrowser
    ? new Stagehand({
        ...modelConfig,
        env: "LOCAL",
        localBrowserLaunchOptions: {
          viewport: DESKTOP_VIEWPORT,
          headless: config.headlessBrowser,
        },
      })
    : new Stagehand({
        ...modelConfig,
        env: "BROWSERBASE",
        apiKey: config.browserbaseApiKey,
        projectId: config.browserbaseProjectId,
        browserbaseSessionCreateParams: {
          projectId: config.browserbaseProjectId,
          timeout: Math.floor(config.sessionTimeoutMs / 1000), // seconds
        },
      });

  try {
    await stagehand.init();
    const sessionId = stagehand.browserbaseSessionID;
    // Browserbase hosts the replay; a local run records it itself and ships it
    // as a workflow artifact, so the run page is where a human goes to find it.
    const replayUrl = sessionId
      ? `https://www.browserbase.com/sessions/${sessionId}`
      : config.actionRunUrl || undefined;
    console.log(
      config.localBrowser
        ? `local browser session (model ${EXECUTOR_MODEL})`
        : `browserbase session ${sessionId ?? "?"} — replay ${replayUrl ?? "n/a"}`,
    );

    const page =
      stagehand.context.activePage() ?? (await stagehand.context.newPage());
    await page.setViewportSize(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    await page.addInitScript(DIALOG_SUPPRESS);
    if (isRecording()) await page.addInitScript(recorderInitScript());

    const items: ItemEvidence[] = [];
    const recordings: ItemRecording[] = [];
    for (const item of plan.items) {
      items.push(await runItem(stagehand, page, previewUrl, item));
      // Drained per item, not per run: the recorder restarts on every full page
      // load, so the buffer only ever holds the current document's events.
      if (isRecording()) {
        dbg("draining rrweb events");
        const t = Date.now();
        const events = await drainEvents(page);
        dbg(`drained ${events.length} events in ${Date.now() - t}ms`);
        recordings.push({ intent: item.intent, route: item.route, events });
      }
    }
    if (isRecording()) await writeReplay(recordings);

    return { sessionId, replayUrl, items };
  } catch (error) {
    // Session-level failure (init/connect) — stay silent, never red.
    console.error(
      "execution failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    await stagehand.close().catch(() => {});
    releaseSlot();
  }
}

type StagehandPage = ReturnType<typeof Stagehand.prototype.context.activePage> &
  object;

async function runItem(
  stagehand: Stagehand,
  page: StagehandPage,
  previewUrl: string,
  item: TestPlan["items"][number],
): Promise<ItemEvidence> {
  const consoleErrors: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  };
  page.on("console", onConsole);

  let error: string | null = null;
  let verdict: ItemEvidence["verdict"] = "uncertain";
  let reasoning = "";

  try {
    const target = withBypass(new URL(item.route, previewUrl).toString());
    // Two-phase navigation. The hard gate is DOM-ready: act and the judge read
    // the DOM/a11y tree, so this is all correctness needs — and on a cold
    // preview (fresh profile, uncached /_next/image optimizations) full "load"
    // can blow the whole timeout while the DOM has long been usable.
    dbg(`goto ${target}`);
    let t = Date.now();
    await page.goto(target, {
      waitUntil: "domcontentloaded",
      timeoutMs: NAV_TIMEOUT_MS,
    });
    dbg(`goto done in ${Date.now() - t}ms; page: ${await pageState(page)}`);
    // Then a bounded, non-fatal grace period for assets to finish, so the
    // recording shows the page as a user would see it — the replay is what
    // builds trust in the verdict. A page that never fires "load" costs this
    // wait and nothing else; visual completeness must never abort an item.
    t = Date.now();
    await page.waitForLoadState("load", ASSET_SETTLE_MS).catch(() => {});
    dbg(`asset settle ended after ${Date.now() - t}ms; page: ${await pageState(page)}`);

    // Perform each natural-language step. A step the model can't do (act throws)
    // is an execution problem → uncertain, not a false fail; stop the item there.
    for (const [index, step] of item.steps.entries()) {
      dbg(`act ${index + 1}/${item.steps.length}: ${step}`);
      t = Date.now();
      await stagehand.act(step);
      dbg(`act ${index + 1} done in ${Date.now() - t}ms`);
    }
    dbg(`judging; page: ${await pageState(page)}`);
    t = Date.now();

    // Judge `expected` against the page via Stagehand's DOM-grounded extract.
    // It sees only the DOM/accessibility tree — not rendered pixels, styling,
    // the URL, or native dialogs — so an expectation that hinges on any of those
    // is genuinely unjudgeable here. Rather than force a pass/fail (a visual-only
    // highlight the human sees in the replay would read as a false fail), the
    // judge can answer "cannot_tell".
    const judgment = await stagehand.extract(
      `Determine whether this expectation is satisfied: "${item.expected}".\n` +
        `You can see only the page's DOM/accessibility tree — not its rendered ` +
        `pixels or CSS, the browser URL, or native dialogs. Answer "pass" only ` +
        `if the outcome is clearly present there, "fail" if it is clearly ` +
        `contradicted, and "cannot_tell" if judging it would need something you ` +
        `cannot see.`,
      JudgeSchema,
    );
    dbg(`judge done in ${Date.now() - t}ms`);
    // "cannot_tell" is not a test failure — it's a blind spot of a DOM-only
    // judge. Treat it like an execution gap: uncertain, so callers stay silent
    // (never a wrong red).
    verdict =
      judgment.verdict === "cannot_tell" ? "uncertain" : judgment.verdict;
    reasoning = judgment.reasoning;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    page.off("console", onConsole);
  }

  console.log(
    `  item "${item.intent}" @ ${item.route}: ` +
      (error
        ? `uncertain (execution error: ${error})`
        : `${verdict}${reasoning ? ` — ${reasoning}` : ""}` +
          `${consoleErrors.length ? ` [${consoleErrors.length} console error(s)]` : ""}`),
  );

  return {
    intent: item.intent,
    route: item.route,
    verdict,
    reasoning,
    consoleErrors,
    error,
  };
}
