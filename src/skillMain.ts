import { parseLocalSkillOptions } from "./skillOptions.js";
import { subscriptionBackend } from "./subscriptionCli.js";

process.env.GREENLIGHT_LOCAL_BROWSER = "1";
process.env.GREENLIGHT_HEADLESS = "1";

try {
  if (!subscriptionBackend()) {
    throw new Error(
      "Greenlight must be launched through its Codex or Claude Code skill.",
    );
  }
  const input = process.argv.slice(2);
  const initializing = input[0] === "init";
  const options = initializing ? { args: input, replayDir: "" } : parseLocalSkillOptions(input);
  process.env.GREENLIGHT_REPLAY_DIR = options.replayDir;
  const { runGreenlightSkill } = await import("./skill.js");
  let currentStage = "Starting Greenlight...";
  let stageStarted = Date.now();
  const animated = initializing && process.stderr.isTTY && !process.env.CI && process.env.TERM !== "dumb";
  const frames = ["● ○ ○", "○ ● ○", "○ ○ ●", "○ ● ○"];
  let frame = 0;
  const draw = () => process.stderr.write(`\r\x1b[2K${frames[frame++ % frames.length]} ${currentStage}`);
  const onProgress = (message: string) => {
    currentStage = message.replace(/[\r\n\x00-\x1f\x7f]/g, " ");
    stageStarted = Date.now();
    if (animated) process.stderr.write("\r\x1b[2K");
    console.error(`[Greenlight progress] ${currentStage}`);
  };
  onProgress(initializing ? "Preparing browser setup..." : currentStage);
  const animation = animated ? setInterval(draw, 180) : undefined;
  animation?.unref();
  const heartbeat = setInterval(() => {
    const elapsed = Math.floor((Date.now() - stageStarted) / 1000);
    if (elapsed >= 25) {
      if (animated) process.stderr.write("\r\x1b[2K");
      console.error(`[Greenlight progress] ${currentStage} (${elapsed}s elapsed)`);
    }
  }, 25_000);
  heartbeat.unref();
  try {
    const report = initializing
      ? await (await import("./init.js")).runGreenlightInit(input[1], input.slice(2).join(" "), onProgress)
      : await runGreenlightSkill(options.args, { onProgress });
    if (animation) { clearInterval(animation); process.stderr.write("\r\x1b[2K"); }
    console.log(report);
  } finally {
    clearInterval(heartbeat);
    if (animation) { clearInterval(animation); process.stderr.write("\r\x1b[2K"); }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Greenlight: ${message}`);
  process.exitCode = 1;
}
