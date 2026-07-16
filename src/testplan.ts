import "dotenv/config";
import { generateObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import type { PrContext } from "./context.js";

// Reads OPENROUTER_API_KEY from the environment. One key, any model on
// openrouter.ai — swap via GREENLIGHT_MODEL without code changes.
const openrouter = createOpenRouter();

const MODEL = process.env.GREENLIGHT_MODEL ?? "moonshotai/kimi-k2.6";

const TestPlanItemSchema = z.object({
  intent: z.string().describe("What user-visible behavior this verifies, in plain English"),
  route: z.string().describe('Path on the preview deployment to visit, e.g. "/checkout"'),
  steps: z
    .array(z.string())
    .describe("Concrete browser actions, one per step, executable by Playwright"),
  expected: z.string().describe("The observable outcome that means PASS"),
});

const TestPlanSchema = z.object({
  summary: z.string().describe("One sentence: what this PR is trying to do"),
  confidence: z
    .enum(["high", "low"])
    .describe('"high" when title/body/issue state intent clearly; "low" when inferred from diff alone'),
  items: z.array(TestPlanItemSchema).describe("Empty if nothing is browser-testable"),
});

export type TestPlan = z.infer<typeof TestPlanSchema>;

const SYSTEM_PROMPT = `You are Greenlight, an automated PR test bot for Next.js apps deployed on Vercel. Given a pull request's intent signals (title, description, linked issue, commit messages) and its diff with surrounding code, produce a test plan that verifies the intended user-visible behavior on the PR's Vercel preview deployment.

Rules:
- Ground every item in evidence from the PR. Test what the change is *for*, not everything the app does. Never invent features that aren't in the diff or description.
- Only propose tests a browser can execute against a deployed preview: navigate, click, type, submit, and observe rendered output. No unit tests, no direct API assertions, no access to the codebase at runtime.
- Routes come from the Next.js file layout (app/ or pages/ directories) visible in the changed file paths and contents.
- Steps must be concrete and self-contained: "Type 'test@example.com' into the email field", not "test the form". Assume the tester has never seen this app.
- Prefer 1-3 high-confidence items over many speculative ones. A wrong FAIL is far worse than a missed test.
- If the PR body/title are empty or uninformative, infer intent from the diff alone and set confidence to "low".
- If the change has no user-visible browser-testable surface (pure refactor, CI config, docs, dependency bumps), return an empty items array and say why in the summary.`;

function section(header: string, content: string): string {
  return `## ${header}\n${content.trim() || "(empty)"}\n`;
}

export function renderContext(ctx: PrContext): string {
  const parts = [
    section("PR title", ctx.title),
    section("PR description", ctx.body),
    section("Commit messages", ctx.commitMessages.map((m) => `- ${m.split("\n")[0]}`).join("\n")),
  ];
  if (ctx.linkedIssue) {
    parts.push(
      section(
        `Linked issue #${ctx.linkedIssue.number}`,
        `${ctx.linkedIssue.title}\n\n${ctx.linkedIssue.body}`,
      ),
    );
  }
  parts.push(
    section(
      "Changed files",
      ctx.changedFiles
        .map((f) => `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`)
        .join("\n"),
    ),
  );
  const patches = ctx.changedFiles
    .filter((f) => f.patch)
    .map((f) => `--- ${f.path}\n${f.patch}`)
    .join("\n\n");
  parts.push(section("Diff", patches));
  for (const file of ctx.fileContents) {
    parts.push(section(`Full file at head: ${file.path}`, file.content));
  }
  if (ctx.packageJson) {
    parts.push(section("package.json", ctx.packageJson));
  }
  if (ctx.truncated) {
    parts.push("Note: some files/patches were truncated for size; the diff above is partial.\n");
  }
  return parts.join("\n");
}

/**
 * Turns PR context into a structured test plan. Returns null when the model
 * fails to produce schema-valid output — callers treat that as "stay silent".
 */
export async function generateTestPlan(ctx: PrContext): Promise<TestPlan | null> {
  try {
    const { object } = await generateObject({
      model: openrouter.chat(MODEL),
      schema: TestPlanSchema,
      system: SYSTEM_PROMPT,
      prompt: renderContext(ctx),
      // Without a cap the request defaults to the model's max, and OpenRouter
      // pre-authorizes that many output tokens against the account balance.
      maxOutputTokens: 4000,
    });
    return object;
  } catch (error) {
    console.warn(
      "test plan generation failed:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
