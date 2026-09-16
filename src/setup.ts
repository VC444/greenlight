import { open, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "acorn";
import type { Page } from "playwright-core";

export const SETUP_PATH = "~/.greenlight/setup.ts";
export const SETUP_TIMEOUT_MS = 30_000;
const MAX_SETUP_BYTES = 8_000;

// Generated hooks deliberately have only page/locator capabilities. Validate before
// compiling, including local files, so page content cannot introduce Node access.
const locators = new Set(["getByRole", "getByText", "getByLabel", "getByPlaceholder", "getByTestId", "getByTitle", "getByAltText", "locator", "filter", "first", "last", "nth", "and", "or"]);
const actions = new Set(["click", "check", "uncheck", "setChecked", "fill", "selectOption", "press", "hover", "waitFor", "isVisible", "isHidden", "isChecked", "isEnabled", "count", "textContent", "innerText", "inputValue", "getAttribute"]);
type Syntax = any;

export function parseSetup(content: string): (args: { page: Page }) => Promise<void> {
  if (!content.trim() || Buffer.byteLength(content) > MAX_SETUP_BYTES || content.split("\n").length > 100) {
    throw new Error(`${SETUP_PATH} must contain a small hook (at most 8000 bytes and 100 lines).`);
  }
  const invalid = (): never => { throw new Error(`${SETUP_PATH}: use an exported async setup({ page }) function with awaited Playwright locator actions, const variables, and if statements only.`); };
  let tree: Syntax;
  try { tree = parse(content, { ecmaVersion: "latest", sourceType: "module" }); }
  catch { return invalid(); }
  const fn = tree.body[0]?.declaration;
  if (tree.body.length !== 1 || tree.body[0].type !== "ExportDefaultDeclaration" ||
      fn?.type !== "FunctionDeclaration" || !fn.async || fn.generator || fn.id?.name !== "setup" ||
      fn.params.length !== 1 || fn.params[0].type !== "ObjectPattern") invalid();
  const properties = fn.params[0].properties;
  if (properties.length !== 1 || !properties[0].shorthand || properties[0].key.name !== "page" ||
      properties[0].value.type !== "Identifier") invalid();
  type Kind = "page" | "locator" | "value";
  function expression(node: Syntax, scope: Map<string, Kind>, awaited = false): Kind {
    switch (node.type) {
      case "Literal": return "value";
      case "Identifier": return scope.get(node.name) ?? invalid();
      case "AwaitExpression": return expression(node.argument, scope, true);
      case "ArrayExpression":
        for (const item of node.elements) if (item) { if (expression(item, scope) !== "value") invalid(); }
        return "value";
      case "ObjectExpression":
        for (const prop of node.properties) {
          if (prop.type !== "Property" || prop.computed || prop.method || prop.kind !== "init" ||
              ["__proto__", "constructor", "prototype"].includes(prop.key.name ?? prop.key.value) ||
              expression(prop.value, scope) !== "value") invalid();
        }
        return "value";
      case "UnaryExpression":
        if (!["!", "-", "+"].includes(node.operator) || expression(node.argument, scope) !== "value") invalid();
        return "value";
      case "LogicalExpression":
      case "BinaryExpression":
        if (!["&&", "||", "??", "===", "!==", "==", "!=", "<", ">", "<=", ">="].includes(node.operator) ||
            expression(node.left, scope) !== "value" || expression(node.right, scope) !== "value") invalid();
        return "value";
      case "CallExpression": {
        const member = node.callee;
        if (member.type !== "MemberExpression" || member.computed || member.optional || node.optional) invalid();
        const receiver = expression(member.object, scope);
        const method = member.property.name;
        if (receiver !== "page" && receiver !== "locator") invalid();
        if (!locators.has(method) && !(receiver === "locator" && actions.has(method) && awaited)) invalid();
        for (const arg of node.arguments) {
          const kind = expression(arg, scope);
          if (kind === "page" || (kind === "locator" && !["and", "or"].includes(method))) invalid();
        }
        return locators.has(method) ? "locator" : "value";
      }
      default: return invalid();
    }
  }
  function statement(node: Syntax, scope: Map<string, Kind>): void {
    switch (node.type) {
      case "BlockStatement": {
        const local = new Map(scope);
        for (const child of node.body) statement(child, local);
        break;
      }
      case "VariableDeclaration":
        if (node.kind !== "const") invalid();
        for (const decl of node.declarations) {
          if (decl.id.type !== "Identifier" || scope.has(decl.id.name) || !decl.init) invalid();
          scope.set(decl.id.name, expression(decl.init, scope));
        }
        break;
      case "ExpressionStatement":
        if (node.expression.type !== "AwaitExpression") invalid();
        expression(node.expression, scope);
        break;
      case "IfStatement":
        if (expression(node.test, scope) !== "value") invalid();
        statement(node.consequent, new Map(scope));
        if (node.alternate) statement(node.alternate, new Map(scope));
        break;
      case "ReturnStatement":
        if (node.argument) invalid();
        break;
      default: invalid();
    }
  }
  statement(fn.body, new Map([["page", "page"]]));
  return new Function(`"use strict"; return (${content.slice(fn.start, fn.end)});`)() as (args: { page: Page }) => Promise<void>;
}

export async function readSetup(homeDir = os.homedir(), allowLegacy = false): Promise<string | null> {
  let file;
  try { file = await open(path.join(homeDir, ".greenlight", "setup.ts"), "r"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Could not read ${SETUP_PATH}.`);
    if (!allowLegacy) for (const name of ["setup.yaml", "setup.md"]) {
      try { await lstat(path.join(homeDir, ".greenlight", name)); }
      catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new Error("Could not inspect legacy browser setup.");
      }
      throw new Error(`Legacy ${name} found. Run greenlight init <preview URL> "<setup instructions>" to replace it with Playwright. The original file is preserved.`);
    }
    return null;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SETUP_BYTES) throw new Error(`${SETUP_PATH} must be a UTF-8 file of at most ${MAX_SETUP_BYTES} bytes.`);
    const bytes = await file.readFile();
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); }
    catch { throw new Error(`${SETUP_PATH} must contain UTF-8 text.`); }
    parseSetup(content);
    return content;
  } finally { await file.close(); }
}

export class SetupBlockedError extends Error {
  constructor(reason: string) { super(`Setup blocked: ${reason}`); this.name = "SetupBlockedError"; }
}

export async function applySetup(content: string, page: Page, onProgress?: (message: string) => void,
  timeoutMs = SETUP_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const setup = parseSetup(content);
    onProgress?.("Applying Playwright setup...");
    await Promise.race([
      setup({ page }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // Closing the target cancels pending actions. The caller must stop the run.
          void page.close().catch(() => {});
          reject(new SetupBlockedError("Playwright setup timed out."));
        }, timeoutMs);
      }),
    ]);
    onProgress?.("Browser setup ready.");
  } catch (error) {
    if (error instanceof SetupBlockedError) throw error;
    throw new SetupBlockedError("Playwright setup could not complete. Run init with updated instructions.");
  } finally { if (timer) clearTimeout(timer); }
}
