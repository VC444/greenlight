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
  const options = parseLocalSkillOptions(process.argv.slice(2));
  process.env.GREENLIGHT_REPLAY_DIR = options.replayDir;
  const { runGreenlightSkill } = await import("./skill.js");
  const report = await runGreenlightSkill(options.args);
  console.log(report);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Greenlight: ${message}`);
  process.exitCode = 1;
}
