import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

function loadPrivateKey(path: string): string {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read private key at ${path} (PRIVATE_KEY_PATH).`);
    process.exit(1);
  }
  // GitHub downloads keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but Octokit's
  // auth uses WebCrypto, which only accepts PKCS#8 — convert if needed.
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    pem = createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  }
  return pem;
}

/** Resolves on first access, then remembers. */
function once<T>(resolve: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= resolve());
}

// The GitHub App credentials are the only settings the Action entry point has no
// way to supply — it authenticates with the runner's GITHUB_TOKEN instead. They
// resolve lazily so importing this module never demands them; the App path still
// fails exactly as before, just at first access rather than at import.
const appId = once(() => required("APP_ID"));
const webhookSecret = once(() => required("WEBHOOK_SECRET"));
const privateKey = once(() => loadPrivateKey(required("PRIVATE_KEY_PATH")));

export const config = {
  get appId() {
    return appId();
  },
  get webhookSecret() {
    return webhookSecret();
  },
  get privateKey() {
    return privateKey();
  },
  port: Number(process.env.PORT ?? 3000),
  webhookPath: "/api/webhooks",
  // Optional: secret from Vercel "Deployment Protection → Protection Bypass for
  // Automation". Empty when previews are public. Used only to reach guarded
  // previews, never sent to GitHub.
  vercelBypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? "",
  // How long to wait for a Vercel preview to build before giving up (staying
  // silent, never red). Vercel Next.js previews are typically well under this.
  previewTimeoutMs: Number(process.env.PREVIEW_TIMEOUT_MS ?? 300_000),
  // Testing switch: when set, skip the Fireworks call and drive the pipeline
  // from src/mockPlan.ts instead, so preview access + browser automation can be
  // validated deterministically without spending credits. Off = real model.
  useMockPlan: process.env.GREENLIGHT_MOCK_PLAN === "1",
  // Testing switch: run the browser locally (Stagehand env "LOCAL", a Chrome on
  // this machine) instead of opening a Browserbase cloud session. No Browserbase
  // credits are spent and no API key/project id is required — only Fireworks
  // (which still drives act/extract). Ideal for iterating for free; prod stays
  // on Browserbase (unset). LLM inference is identical in both modes.
  localBrowser: process.env.GREENLIGHT_LOCAL_BROWSER === "1",
  // Stagehand launches a headed Chrome by default, which needs a display — fine
  // on a laptop (and useful: you can watch a plan run), impossible on a CI
  // runner. Recording is rrweb, i.e. DOM-based, so nothing is lost headless.
  headlessBrowser: process.env.GREENLIGHT_HEADLESS === "1",
  // Browserbase (Phase 4 execution). Both empty = execution skipped (stay
  // silent, never red). Free tier allows ~3 concurrent sessions.
  browserbaseApiKey: process.env.BROWSERBASE_API_KEY ?? "",
  browserbaseProjectId: process.env.BROWSERBASE_PROJECT_ID ?? "",
  maxConcurrentSessions: Number(process.env.MAX_CONCURRENT_SESSIONS ?? 3),
  // Hard cap on a single browser session's lifetime so a hung run can't burn
  // the whole free-tier budget.
  sessionTimeoutMs: Number(process.env.SESSION_TIMEOUT_MS ?? 900_000),
  // Where to write the rrweb session replay. Empty = no recording at all, which
  // is the default everywhere except the Action (where the workflow sets it and
  // uploads the result as an artifact).
  replayDir: process.env.GREENLIGHT_REPLAY_DIR ?? "",
  // Embed images as data URIs instead of referencing them by URL. On by
  // default: URL-referenced images require the viewer to have access to the
  // preview (protected previews demand a bypass cookie they won't have), so
  // the default replay must carry its own pixels to be trustworthy. Costs
  // artifact size (measured ~50x on an image-heavy page); set to "0" to trade
  // completeness for small artifacts on public, long-lived previews.
  replayInlineImages: process.env.GREENLIGHT_REPLAY_INLINE_IMAGES !== "0",
  // Inside a GitHub Actions run there is no hosted replay to link to — the
  // recording ships as an artifact on the workflow run, so the run page is the
  // closest thing to a replay URL.
  actionRunUrl: actionRunUrl(),
};

function actionRunUrl(): string {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repository && runId
    ? `${server}/${repository}/actions/runs/${runId}`
    : "";
}
