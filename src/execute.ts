import "dotenv/config";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import type { TestPlan } from "./testplan.js";
import { withBypass } from "./preview.js";
import { config } from "./config.js";

// Plan steps assume a desktop layout (the nav collapses under ~768px); use a
// comfortable desktop size so responsive UIs render their full-width state.
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const NAV_TIMEOUT_MS = 30_000;

// Stagehand's act/extract reasoning runs on OUR Fireworks model, not the
// Browserbase Model Gateway (disableAPI keeps it all local). The provider
// PREFIX matters: Stagehand's "openai/…" maps to @ai-sdk/openai, whose default
// model hits OpenAI's *Responses* API (/responses) — which Fireworks doesn't
// implement, so every call fails with "Invalid JSON response". "togetherai/…"
// maps to @ai-sdk/togetherai, an OpenAI-*compatible* provider that hits
// /chat/completions and honors a custom baseURL — exactly what Fireworks serves.
const FIREWORKS_PROVIDER_PREFIX = "togetherai";
const FIREWORKS_BASE_URL = "https://api.fireworks.ai/inference/v1";
const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY ?? "";
const EXECUTOR_MODEL =
  process.env.GREENLIGHT_EXECUTOR_MODEL ??
  process.env.GREENLIGHT_MODEL ??
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
  passed: z
    .boolean()
    .describe("true ONLY if the expected outcome is clearly observable now"),
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
  screenshot: Buffer | null;
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

/** True when everything execution needs is configured: a remote browser
 *  (Browserbase) and the LLM that drives + judges the steps (Fireworks). */
export function canExecute(): boolean {
  return Boolean(
    config.browserbaseApiKey &&
    config.browserbaseProjectId &&
    FIREWORKS_API_KEY,
  );
}

/**
 * Drives the PR's preview through the plan in a remote Browserbase browser,
 * driven by Stagehand acting on natural-language steps and an LLM judge for each
 * item's `expected`. Returns per-item verdicts + evidence and the session replay
 * URL, or null when execution can't run at all (callers stay silent).
 *
 * Sessions are opened late (only once we have a ready preview) and
 * lifetime-capped by browserbaseSessionCreateParams.timeout.
 */
export async function runPlan(
  previewUrl: string,
  plan: TestPlan,
): Promise<ExecutionResult | null> {
  if (!canExecute()) {
    console.warn(
      "execution not configured (needs BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID, FIREWORKS_API_KEY) — skipping",
    );
    return null;
  }

  await acquireSlot();
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: config.browserbaseApiKey,
    projectId: config.browserbaseProjectId,
    // Reason locally on our Fireworks model — never route act/extract through
    // Browserbase's server-side API / Model Gateway.
    disableAPI: true,
    verbose: 0,
    disablePino: true,
    model: {
      modelName: `${FIREWORKS_PROVIDER_PREFIX}/${EXECUTOR_MODEL}`,
      apiKey: FIREWORKS_API_KEY,
      baseURL: FIREWORKS_BASE_URL,
    },
    browserbaseSessionCreateParams: {
      projectId: config.browserbaseProjectId,
      timeout: Math.floor(config.sessionTimeoutMs / 1000), // seconds
    },
  });

  try {
    await stagehand.init();
    const sessionId = stagehand.browserbaseSessionID;
    const replayUrl = sessionId
      ? `https://www.browserbase.com/sessions/${sessionId}`
      : undefined;
    console.log(
      `browserbase session ${sessionId ?? "?"} — replay ${replayUrl ?? "n/a"}`,
    );

    const page =
      stagehand.context.activePage() ?? (await stagehand.context.newPage());
    await page.setViewportSize(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
    await page.addInitScript(DIALOG_SUPPRESS);

    const items: ItemEvidence[] = [];
    for (const item of plan.items) {
      items.push(await runItem(stagehand, page, previewUrl, item));
    }

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
  let screenshot: Buffer | null = null;
  let verdict: ItemEvidence["verdict"] = "uncertain";
  let reasoning = "";

  try {
    const target = withBypass(new URL(item.route, previewUrl).toString());
    await page.goto(target, { waitUntil: "load", timeoutMs: NAV_TIMEOUT_MS });

    // Perform each natural-language step. A step the model can't do (act throws)
    // is an execution problem → uncertain, not a false fail; stop the item there.
    for (const step of item.steps) {
      await stagehand.act(step);
    }

    // Judge `expected` against the page via Stagehand's DOM-grounded extract.
    // Note: this only sees the DOM/accessibility tree, so expectations about
    // native dialogs (alert/confirm/prompt) aren't judged here — deferred.
    const judgment = await stagehand.extract(
      `Determine whether this expectation is now satisfied: "${item.expected}". ` +
        `Answer passed=true only if it is clearly met.`,
      JudgeSchema,
    );
    verdict = judgment.passed ? "pass" : "fail";
    reasoning = judgment.reasoning;
    screenshot = await page.screenshot({ fullPage: true });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    // Best-effort screenshot for debugging even on failure.
    screenshot = await page.screenshot({ fullPage: true }).catch(() => null);
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
    screenshot,
    consoleErrors,
    error,
  };
}
