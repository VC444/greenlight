import "dotenv/config";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";
import type { PrContext } from "./context.js";

// Fireworks via the generic OpenAI-compatible factory rather than
// @ai-sdk/fireworks: the dedicated package never sets
// supportsStructuredOutputs, which makes the SDK silently drop the JSON
// schema from requests. With the flag on, Fireworks receives the schema and
// enforces it at decode time (grammar-constrained — malformed output is
// impossible, not just discouraged).
const fireworks = createOpenAICompatible({
  name: "fireworks",
  baseURL: "https://api.fireworks.ai/inference/v1",
  apiKey: process.env.FIREWORKS_API_KEY,
  supportsStructuredOutputs: true,
});

const MODEL =
  process.env.GREENLIGHT_MODEL ?? "accounts/fireworks/models/kimi-k2p7-code";

const TestPlanItemSchema = z.object({
  intent: z
    .string()
    .describe("What user-visible behavior this verifies, in plain English"),
  route: z
    .string()
    .describe('Path on the preview deployment to visit, e.g. "/checkout"'),
  steps: z
    .array(z.string())
    .describe(
      "Concrete browser actions, one per step, executable by Playwright",
    ),
  expected: z.string().describe("The observable outcome that means PASS"),
});

const TestPlanSchema = z.object({
  summary: z.string().describe("One sentence: what this PR is trying to do"),
  confidence: z
    .enum(["high", "low"])
    .describe(
      '"high" when title/body/issue state intent clearly; "low" when inferred from diff alone',
    ),
  items: z
    .array(TestPlanItemSchema)
    .describe("Empty if nothing is browser-testable"),
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
    section(
      "Commit messages",
      ctx.commitMessages.map((m) => `- ${m.split("\n")[0]}`).join("\n"),
    ),
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
        .map(
          (f) => `- ${f.path} (${f.status}, +${f.additions}/-${f.deletions})`,
        )
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
    parts.push(
      "Note: some files/patches were truncated for size; the diff above is partial.\n",
    );
  }
  return parts.join("\n");
}

/**
 * Turns PR context into a structured test plan. Returns null when the model
 * fails to produce schema-valid output — callers treat that as "stay silent".
 */
/**
 * Some hosts treat json_schema as a suggestion: the model emits the right JSON
 * but wrapped in a ```json fence, which the SDK's strict parser rejects. Unwrap
 * and validate it ourselves before discarding the attempt.
 */
function salvagePlan(raw: string | undefined): TestPlan | null {
  if (!raw) return null;
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const result = TestPlanSchema.safeParse(JSON.parse(unfenced));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

// The response_format schema is enforced during decoding, but the model never
// actually reads it — Fireworks recommends also stating it in the prompt.
const SCHEMA_NOTE = `\n\nRespond with a single JSON object matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(TestPlanSchema))}`;

export async function generateTestPlan(
  ctx: PrContext,
): Promise<TestPlan | null> {
  // One retry covers transient upstream errors and the rare truncated response.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model: fireworks.chatModel(MODEL),
        output: Output.object({ schema: TestPlanSchema }),
        system: SYSTEM_PROMPT + SCHEMA_NOTE,
        prompt: renderContext(ctx),
        // Cost guard only; a truncated response is caught by the finishReason
        // check below. Plans are well under this in practice.
        maxOutputTokens: 4000,
      });
      // The SDK only parses structured output when the model finished cleanly;
      // on any other finish reason (hit the token cap, content filter, …) the
      // .output getter throws with no diagnostics. Handle it before touching it.
      if (result.finishReason !== "stop") {
        const salvaged = salvagePlan(result.text);
        if (salvaged) {
          console.log("salvaged a valid plan despite early stop");
          return salvaged;
        }
        console.warn(
          `test plan attempt ${attempt}/${MAX_ATTEMPTS}: model stopped early ` +
            `(finishReason: ${result.finishReason}, output tokens: ${result.usage.outputTokens}, ${result.response.modelId})`,
        );
        continue;
      }
      return result.output;
    } catch (error) {
      if (NoObjectGeneratedError.isInstance(error)) {
        const salvaged = salvagePlan(error.text);
        if (salvaged) {
          console.log("salvaged a valid plan from fenced JSON output");
          return salvaged;
        }
        const model = error.response?.modelId ?? "unknown model";
        console.warn(
          `test plan attempt ${attempt}/${MAX_ATTEMPTS}: output didn't match schema (${model})`,
        );
        if (error.text)
          console.warn(`  raw output started: ${error.text.slice(0, 200)}`);
        continue;
      }
      console.warn(
        "test plan generation failed:",
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
  console.warn(`test plan generation failed after ${MAX_ATTEMPTS} attempts`);
  return null;
}
