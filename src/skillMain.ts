import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseLocalSkillOptions, readRunNotes } from "./skillOptions.js";
import { subscriptionBackend } from "./subscriptionCli.js";

process.env.GREENLIGHT_LOCAL_BROWSER = "1";
process.env.GREENLIGHT_HEADLESS = "1";

// Temporary local testing marker. Remove this block and its uses before pushing.
// The fallback survives npx packaging, which omits the checkout's Git metadata.
let runtimeRevision = "f8d05f7 (local testing build with uncommitted changes)";
const runtimeRoot = new URL("../", import.meta.url);
if (existsSync(new URL(".git", runtimeRoot))) {
  try {
    const git = (...args: string[]) => execFileSync("git", args, {
      cwd: fileURLToPath(runtimeRoot), encoding: "utf8", timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const hash = git("rev-parse", "--short", "HEAD");
    const dirty = git("status", "--porcelain");
    runtimeRevision = `${hash}${dirty ? " (uncommitted changes)" : ""}`;
  } catch {
    // Keep the packaged build marker when Git is unavailable.
  }
}
const runtimeHeader = `Greenlight runtime commit: ${runtimeRevision}`;
console.error(runtimeHeader);


try {
  if (!subscriptionBackend()) {
    throw new Error(
      "Greenlight must be launched through its Codex or Claude Code skill.",
    );
  }
  const input = process.argv.slice(2);
  const initializing = input[0] === "init";
  if (initializing) {
    const { parseInitOptions, runGreenlightInit } = await import("./init.js");
    console.log(await runGreenlightInit(parseInitOptions(input.slice(1))));
  } else {
    const options = parseLocalSkillOptions(input);
    const runNotes = await readRunNotes(options.contextFile);
    process.env.GREENLIGHT_REPLAY_DIR = options.replayDir;
    const { runGreenlightSkill } = await import("./skill.js");
    let currentStage = "Starting Greenlight...";
    let stageStarted = Date.now();
    const onProgress = (message: string) => {
      currentStage = message.replace(/[\r\n\x00-\x1f\x7f]/g, " ");
      stageStarted = Date.now();
      console.error(`[Greenlight progress] ${currentStage}`);
    };
    onProgress(currentStage);
    const heartbeat = setInterval(() => {
      const elapsed = Math.floor((Date.now() - stageStarted) / 1000);
      if (elapsed >= 25) {
        console.error(`[Greenlight progress] ${currentStage} (${elapsed}s elapsed)`);
      }
    }, 25_000);
    heartbeat.unref();
    try {
      const report = await runGreenlightSkill(options.args, { onProgress, runNotes });
      // Preserve the machine-readable prerequisite prompt at the start of stdout.
      console.log(report.startsWith("[Greenlight input required]")
        ? report
        : `${runtimeHeader}\n\n${report}`);
    } finally {
      clearInterval(heartbeat);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Greenlight: ${message}`);
  process.exitCode = 1;
}
