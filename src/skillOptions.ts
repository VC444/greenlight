import os from "node:os";
import path from "node:path";

export const LOCAL_SKILL_USAGE =
  "Usage: greenlight [--no-record | --record-dir <absolute path>] " +
  "<GitHub PR URL> <preview URL>";

export interface LocalSkillOptions {
  args: string[];
  replayDir: string;
}

interface OptionDefaults {
  homeDir?: string;
  now?: Date;
}

function defaultReplayDir(homeDir: string, now: Date): string {
  const timestamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(homeDir, "Desktop", `greenlight-replay-${timestamp}`);
}

export function parseLocalSkillOptions(
  rawArgs: string[],
  defaults: OptionDefaults = {},
): LocalSkillOptions {
  const input = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const args: string[] = [];
  let noRecord = false;
  let replayDir: string | undefined;

  for (let index = 0; index < input.length; index++) {
    const value = input[index]!;
    if (value === "--no-record") {
      noRecord = true;
      continue;
    }
    if (value === "--record-dir") {
      const destination = input[++index];
      if (!destination) {
        throw new Error(
          `--record-dir requires an absolute path. ${LOCAL_SKILL_USAGE}`,
        );
      }
      replayDir = destination;
      continue;
    }
    if (value.startsWith("--record-dir=")) {
      replayDir = value.slice("--record-dir=".length);
      continue;
    }
    if (value.startsWith("--")) {
      throw new Error(`Unknown option: ${value}. ${LOCAL_SKILL_USAGE}`);
    }
    args.push(value);
  }

  if (noRecord && replayDir !== undefined) {
    throw new Error(
      `--no-record and --record-dir cannot be used together. ${LOCAL_SKILL_USAGE}`,
    );
  }
  if (replayDir !== undefined && !path.isAbsolute(replayDir)) {
    throw new Error(
      `--record-dir requires an absolute path. ${LOCAL_SKILL_USAGE}`,
    );
  }
  if (args.length !== 2) {
    throw new Error(LOCAL_SKILL_USAGE);
  }

  return {
    args,
    replayDir: noRecord
      ? ""
      : replayDir ||
        defaultReplayDir(
          defaults.homeDir ?? os.homedir(),
          defaults.now ?? new Date(),
        ),
  };
}
