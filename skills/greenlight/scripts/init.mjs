#!/usr/bin/env node

import { mkdir, open, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const setupPath = path.join(os.homedir(), ".greenlight", "setup.yaml");
const displayPath = "~/.greenlight/setup.yaml";

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    fail(`${label}: expected fields ${keys.join(", ")}`);
  }
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label}: must be nonblank text`);
}

function timeout(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 300_000) {
    fail(`${label}: must be an integer from 1 to 300000`);
  }
}

function validate(content) {
  let recipe;
  try { recipe = JSON.parse(content); }
  catch { fail("Setup must be JSON, which is also valid YAML."); }
  exactKeys(recipe, ["version", "steps", "ready"], "setup");
  if (recipe.version !== 1) fail("version: must be 1");
  if (!Array.isArray(recipe.steps) || recipe.steps.length > 12) {
    fail("steps: must contain at most 12 steps");
  }
  const ids = new Set();
  for (const [index, step] of recipe.steps.entries()) {
    const label = `steps.${index}`;
    exactKeys(step, ["id", "wait_for", "timeout_ms", "actions", "verify"], label);
    text(step.id, `${label}.id`);
    if (!/^[a-zA-Z0-9_-]+$/.test(step.id) || ids.has(step.id)) {
      fail(`${label}.id: must be unique and use only letters, digits, underscores, or hyphens`);
    }
    ids.add(step.id);
    text(step.wait_for, `${label}.wait_for`);
    timeout(step.timeout_ms, `${label}.timeout_ms`);
    if (!Array.isArray(step.actions) || step.actions.length < 1 || step.actions.length > 12) {
      fail(`${label}.actions: must contain 1 to 12 actions`);
    }
    step.actions.forEach((action, actionIndex) => text(action, `${label}.actions.${actionIndex}`));
    text(step.verify, `${label}.verify`);
  }
  exactKeys(recipe.ready, ["condition", "timeout_ms"], "ready");
  text(recipe.ready.condition, "ready.condition");
  timeout(recipe.ready.timeout_ms, "ready.timeout_ms");
}

async function main() {
  let existing;
  try {
    const details = await stat(setupPath);
    if (!details.isFile() || details.size > 16_000) fail(`${displayPath} must be a file of at most 16000 bytes.`);
    existing = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(setupPath));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    console.log(`## Your existing Greenlight setup\n\nSaved at ${displayPath}. Kept your edits unchanged.\n\n\`\`\`yaml\n${existing.trim()}\n\`\`\`\n\nEdit this file directly if you need to change the setup.`);
    return;
  }
  try {
    await stat(path.join(os.homedir(), ".greenlight", "setup.md"));
    fail("Legacy ~/.greenlight/setup.md found. Create ~/.greenlight/setup.yaml using the version 1 schema in docs/browser-setup.md. The original Markdown file has been preserved.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (process.argv.length === 2) {
    console.log("What steps should Greenlight follow to prepare your app before testing? Describe them in order, including exact button or field labels and how to tell the app is ready. If no setup actions are needed, describe only the ready state. No setup file has been written.");
    return;
  }
  if (process.argv.length !== 4 || process.argv[2] !== "--setup-file" ||
      !process.argv[3] || process.argv[3].startsWith("--")) {
    fail("Usage: greenlight init [--setup-file <JSON file>].");
  }
  const bytes = await readFile(process.argv[3]);
  if (bytes.length > 16_000) fail("Setup is too long. No setup file was written.");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  validate(content);
  await mkdir(path.dirname(setupPath), { recursive: true, mode: 0o700 });
  const file = await open(setupPath, "wx", 0o600);
  try { await file.writeFile(content, "utf8"); }
  finally { await file.close(); }
  console.log(`## Greenlight setup saved\n\nSaved your supplied steps at ${displayPath}. Future local checks load it automatically.\n\n\`\`\`json\n${content}\n\`\`\`\n\nEdit this file directly if needed, then run /greenlight <PR URL> <preview URL>.`);
}

try { await main(); }
catch (error) {
  console.error(`Greenlight: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
