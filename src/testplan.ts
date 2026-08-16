import "dotenv/config";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import type { PrContext } from "./context.js";
import { describe, languageModel, planModelSpec } from "./llm.js";

const TestPlanItemSchema = z.object({
  intent: z
    .string()
    .describe("What user-visible behavior this verifies, in plain English"),
  route: z
    .string()
    .describe(
      'The single entry-point path where this journey begins, e.g. "/checkout". ' +
        "The runner navigates here once before the first step; never add steps that re-open it.",
    ),
  steps: z
    .array(z.string())
    .describe(
      "Concrete browser actions for ONE continuous journey, run in order in the " +
        "same tab with no page reload between them (state carries over, exactly " +
        "like a real user). Move between pages by clicking UI elements, not by " +
        "starting over. e.g. \"Type 'test@example.com' into the email field\".",
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
- Routes come from the Next.js file layout (app/ or pages/ directories) visible in the changed file paths and contents. A route is only where a journey *starts*.
- One journey = one item. An item is a full user flow: its steps run in order in a single tab, sharing state, exactly as a real user clicking through. NEVER split a continuous flow across items — every item begins with a fresh page load, so a later item loses everything the earlier steps built (a cart emptied, a form reset, a menu re-closed). If two things are steps of the same flow, they belong in one item's steps. Use separate items only for genuinely independent behaviors a user would reach on their own (e.g. two unrelated features the PR touches).
- Within a journey, move between pages by interacting with the UI ("Click the 'Cart' link"), never by adding a new item per page. Each item yields a single pass/fail, so let \`expected\` describe the journey's final observable outcome.
- Steps must be concrete and self-contained: "Type 'test@example.com' into the email field", not "test the form". Assume the tester has never seen this app.
- Do not emit steps that merely open the route or wait for the page to load — the runner already navigates to \`route\` and waits before your first step. Begin steps at the first real interaction or observation.
- Never emit steps that resize the window or set the browser viewport/screen size — the runner already opens a desktop-width (1280px) viewport, so the desktop navigation is always visible. Write steps as if that has already happened.
- Prefer 1-5 high-confidence items over many speculative ones. A wrong FAIL is far worse than a missed test.
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

// Hosts that enforce the schema at decode time still never show it to the
// model, and hosts that don't enforce it have only this to go on — so state it
// in the prompt either way.
const SCHEMA_NOTE = `\n\nRespond with a single JSON object matching this JSON schema:\n${JSON.stringify(z.toJSONSchema(TestPlanSchema))}`;

const MAX_OUTPUT_TOKENS = 32000;

export async function generateTestPlan(
  ctx: PrContext,
): Promise<TestPlan | null> {
  // Resolve credentials before the SDK does — its error is provider-specific
  // ("See https://docs.fireworks.ai/...") and says nothing about where the key
  // was supposed to come from. A null here has already been explained.
  const spec = planModelSpec();
  if (!spec) return null;
  const model = languageModel(spec);
  // One retry covers transient upstream errors and the rare truncated response.
  const MAX_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model,
        output: Output.object({ schema: TestPlanSchema }),
        system: SYSTEM_PROMPT + SCHEMA_NOTE,
        prompt: renderContext(ctx),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
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
        // Say where the budget went. A reasoning model spends most of it
        // thinking and can hit the cap with no answer text at all, which reads
        // like a dead model unless the thinking is accounted for beside it.
        // Measured in characters, not tokens: hosts that return the reasoning
        // as a separate field still report it as 0 reasoning tokens.
        if (result.finishReason === "length") {
          const thought = result.reasoningText?.length ?? 0;
          console.warn(
            `  hit the ${MAX_OUTPUT_TOKENS}-token output cap after ` +
              `${thought} chars of reasoning and ${result.text.length} of answer. ` +
              (result.text
                ? `Answer ended: ...${result.text.slice(-120)}`
                : `It never started the answer. Raise MAX_OUTPUT_TOKENS or use a model that thinks less.`),
          );
        }
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
  console.warn(
    `test plan generation failed after ${MAX_ATTEMPTS} attempts (${describe(spec)})`,
  );
  return null;
}
