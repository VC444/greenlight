import { readFile } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot } from "./init.js";
import { createNativeSetup } from "./nativeSetup.js";
import { readActionOptions } from "./actionContext.js";

export async function checkSetup(args: string[]): Promise<void> {
  if (args.length !== 1) throw new Error("Usage: greenlight setup-check <preview-url>.");
  const preview = new URL(args[0]!);
  if (!["http:", "https:"].includes(preview.protocol) || preview.username || preview.password) {
    throw new Error("Provide an HTTP(S) preview URL without embedded credentials.");
  }
  const root = repositoryRoot();
  const bytes = await readFile(path.join(root, ".greenlight/setup.ts"));
  if (!bytes.length || bytes.length > 16_000) throw new Error(".greenlight/setup.ts must contain 1 to 16000 bytes.");
  const setup = createNativeSetup(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  process.env.GREENLIGHT_LOCAL_BROWSER = "1";
  process.env.GREENLIGHT_REPLAY_DIR ||= path.join(root, "greenlight-replay");
  const { conditionTimeoutMs } = readActionOptions();
  const { runPlan } = await import("./execute.js");
  try {
    const result = await runPlan(preview.href, {
      summary: "Verify the repository setup script", confidence: "high",
      items: [{ intent: "Native setup", route: "/", steps: [], expected: "Setup completes without throwing" }],
    }, console.log, setup, conditionTimeoutMs, true);
    if (!result) throw new Error("Setup check could not start. Configure GREENLIGHT_MODEL, GREENLIGHT_LLM_API_KEY, and Chrome.");
    const item = result.items[0];
    if (item?.verdict !== "pass") throw new Error(item?.error || "Setup did not complete.");
    console.log("Setup check passed. Review the replay in greenlight-replay before committing .greenlight/setup.ts.");
  } finally { await setup.dispose(); }
}
