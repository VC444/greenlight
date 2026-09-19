import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOCAL_SKILL_USAGE =
  "Usage: greenlight [--no-record | --record-dir <absolute path>] " +
  "[--context-file <absolute path>] <GitHub PR URL> <preview URL>";

export interface LocalSkillOptions {
  args: string[];
  replayDir: string;
  contextFile?: string;
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
  let contextFile: string | undefined;
  let replayDir: string | undefined;

  for (let index = 0; index < input.length; index++) {
    const value = input[index]!;
    if (value === "--context-file" || value.startsWith("--context-file=")) {
      if (contextFile !== undefined) throw new Error("Supply --context-file only once.");
      contextFile = value === "--context-file" ? input[++index] : value.slice("--context-file=".length);
      if (!contextFile || !path.isAbsolute(contextFile)) {
        throw new Error(`--context-file requires an absolute path. ${LOCAL_SKILL_USAGE}`);
      }
      continue;
    }
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
    ...(contextFile ? { contextFile } : {}),
    replayDir: noRecord
      ? ""
      : replayDir ||
        defaultReplayDir(
          defaults.homeDir ?? os.homedir(),
          defaults.now ?? new Date(),
        ),
  };
}

export async function readRunNotes(file?: string): Promise<string> {
  if (!file) return "";
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new Error("Could not read --context-file. Supply a readable UTF-8 text file.");
  }
  if (bytes.length > 16000) throw new Error("--context-file must be at most 16000 bytes.");
  let notes: string;
  try {
    notes = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error("--context-file must contain UTF-8 text.");
  }
  if (!notes) throw new Error("--context-file must not be empty.");
  return notes;
}
