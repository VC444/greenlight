import { mkdir, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSetup, parseSetup } from "./setup.js";

export async function saveInitialSetup(content: string, homeDir = os.homedir()): Promise<string> {
  if (Buffer.byteLength(content) > 16_000) throw new Error("Setup is too long. No setup file was written.");
  parseSetup(content);
  const folder = path.join(homeDir, ".greenlight");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const destination = path.join(folder, "setup.yaml");
  const file = await open(destination, "wx", 0o600);
  try { await file.writeFile(content, "utf8"); } finally { await file.close(); }
  return destination;
}

export function parseInitOptions(args: string[]): { setupFile?: string } {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--setup-file" && args[1] && !args[1].startsWith("--")) {
    return { setupFile: args[1] };
  }
  throw new Error("Usage: greenlight init [--setup-file <YAML file>]. No repository URL is needed; provide your setup steps in chat.");
}

export async function runGreenlightInit(
  options: { setupFile?: string; homeDir?: string } = {},
): Promise<string> {
  const homeDir = options.homeDir ?? os.homedir();
  const existing = await readSetup(homeDir);
  if (existing !== null) {
    return `## Your existing Greenlight setup\n\nSaved at ~/.greenlight/setup.yaml. Kept your edits unchanged.\n\n\`\`\`yaml\n${existing}\n\`\`\`\n\nEdit this file directly if you need to change the setup.`;
  }
  if (!options.setupFile) {
    return "What steps should Greenlight follow to prepare your app before testing? " +
      "Describe them in order, including exact button or field labels and how to tell the app is ready. " +
      "If no setup actions are needed, describe only the ready state. No setup file has been written.";
  }
  const bytes = await readFile(options.setupFile);
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  await saveInitialSetup(content, homeDir);
  return `## Greenlight setup saved\n\nSaved your supplied steps at ~/.greenlight/setup.yaml. Future local checks load it automatically.\n\n\`\`\`yaml\n${content}\n\`\`\`\n\nEdit this file directly if needed, then run /greenlight <PR URL> <preview URL>.`;
}
