#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const STARTER = `import type { Stagehand } from "@browserbasehq/stagehand";
import type { Page } from "playwright-core";
import type { z as Zod } from "zod";

type SetupContext = {
  stagehand: Stagehand;
  page: Page;
  z: typeof Zod;
  previewUrl: string;
  signal: AbortSignal;
};

export default async function setup({ stagehand, page, z, signal }: SetupContext) {
  signal.throwIfAborted();
  // Add the app's preparation and readiness assertions here.
  // Example:
  // const result = await stagehand.act('Click "Continue".', { page });
  // if (!result.success) throw new Error(result.message);
  // const { workspace } = await stagehand.extract(
  //   "Extract the selected workspace name.",
  //   z.object({ workspace: z.string().nullable() }),
  //   { page },
  // );
  // if (workspace !== "Demo") throw new Error("Expected the Demo workspace.");
  throw new Error("Finish .greenlight/setup.ts, then run greenlight setup-check <preview-url>.");
}
`;

export function repositoryRoot(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { throw new Error("Run greenlight init from the app's Git repository."); }
}

function validateSource(content) {
  if (!content.trim() || Buffer.byteLength(content) > 16_000) {
    throw new Error("Setup must contain 1 to 16000 UTF-8 bytes.");
  }
  if (!/\bexport\s+default\b/.test(content)) {
    throw new Error("Setup must default-export an async function. Supply TypeScript, not a YAML recipe.");
  }
}

export async function saveInitialSetup(content, repoDir = repositoryRoot()) {
  validateSource(content);
  const folder = path.join(repoDir, ".greenlight");
  await mkdir(folder, { recursive: true });
  const destination = path.join(folder, "setup.ts");
  const file = await open(destination, "wx", 0o600);
  try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
  return destination;
}

export function parseInitOptions(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === "--prompt") return { prompt: true };
  if (args.length === 2 && args[0] === "--setup-file" && args[1] && !args[1].startsWith("--")) {
    return { setupFile: args[1] };
  }
  throw new Error("Usage: greenlight init [--prompt | --setup-file <TypeScript file>].");
}

export async function runGreenlightInit(options = {}) {
  const repoDir = options.repoDir ?? repositoryRoot();
  let existing;
  try { existing = await readFile(path.join(repoDir, ".greenlight/setup.ts"), "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing !== undefined) {
    return `Existing .greenlight/setup.ts. Kept your edits unchanged.\n\n\`\`\`ts\n${existing.trim()}\n\`\`\``;
  }
  if (options.prompt) {
    return "What should Greenlight do before testing your app, and what should it check to know setup succeeded?";
  }
  const content = options.setupFile
    ? new TextDecoder("utf-8", { fatal: true }).decode(await readFile(options.setupFile))
    : STARTER;
  await saveInitialSetup(content, repoDir);
  return `${options.setupFile ? "Saved your supplied script" : "Created a starter"} at .greenlight/setup.ts.\n` +
    "Review and finish the script, then run greenlight setup-check <preview-url>. " +
    "The script has not been executed or browser-verified. Commit it after testing; PR runs use the version on the base branch.";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(await runGreenlightInit(parseInitOptions(process.argv.slice(2)))); }
  catch (error) {
    console.error(`Greenlight: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
