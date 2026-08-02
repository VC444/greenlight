import "dotenv/config";
import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * The single place Greenlight decides *which* LLM runs. Two very different
 * consumers need the same answer:
 *
 *  - src/testplan.ts calls the AI SDK directly (ai@7) and wants a model object.
 *  - src/execute.ts hands the model to Stagehand, which builds its own provider
 *    from a "prefix/model" string on its own bundled ai@5. We can't pass a model
 *    instance across that version boundary, so we pass coordinates instead.
 *
 * Both come from one `provider/model` spec, so a single env var moves both.
 */

/** Providers reached through their own AI SDK package. Stagehand ships the
 *  matching ai@5 package under the same prefix, so its act/extract calls get
 *  native structured output too — no schema guessing. */
const NATIVE = {
  anthropic: { create: (apiKey: string) => createAnthropic({ apiKey }) },
  openai: { create: (apiKey: string) => createOpenAI({ apiKey }) },
  google: { create: (apiKey: string) => createGoogleGenerativeAI({ apiKey }) },
} as const;

/**
 * OpenAI-compatible hosts, reached through @ai-sdk/openai-compatible.
 *
 * `stagehand.prefix` picks which of Stagehand's bundled providers fronts the
 * host. "togetherai" is the generic escape hatch: unlike "openai" (whose
 * default is OpenAI's *Responses* API, which these hosts don't implement) it is
 * an OpenAI-*compatible* provider that hits /chat/completions and honors a
 * custom baseURL. Providers Stagehand supports natively use their own prefix
 * and their own default baseURL — passing ours would only risk a path mismatch.
 *
 * `structuredOutputs` says whether the host enforces a JSON schema at decode
 * time. Off means the schema is dropped from the request and we lean on the
 * prompt-stated schema plus salvagePlan() instead — worse, but not broken.
 */
const COMPATIBLE = {
  fireworks: {
    baseURL: "https://api.fireworks.ai/inference/v1",
    structuredOutputs: true,
    stagehand: { prefix: "togetherai", passBaseURL: true },
  },
  together: {
    baseURL: "https://api.together.xyz/v1",
    structuredOutputs: true,
    stagehand: { prefix: "togetherai", passBaseURL: false },
  },
  openrouter: {
    baseURL: "https://openrouter.ai/api/v1",
    structuredOutputs: true,
    stagehand: { prefix: "togetherai", passBaseURL: true },
  },
} as const;

export type NativeProvider = keyof typeof NATIVE;
export type CompatibleProvider = keyof typeof COMPATIBLE;
export type Provider = NativeProvider | CompatibleProvider;

function isNative(provider: string): provider is NativeProvider {
  return provider in NATIVE;
}
function isCompatible(provider: string): provider is CompatibleProvider {
  return provider in COMPATIBLE;
}
function isProvider(provider: string): provider is Provider {
  return isNative(provider) || isCompatible(provider);
}

export const PROVIDERS: Provider[] = [
  ...(Object.keys(NATIVE) as NativeProvider[]),
  ...(Object.keys(COMPATIBLE) as CompatibleProvider[]),
];

export interface ModelSpec {
  provider: Provider;
  /** Model id as the provider names it, e.g. "claude-opus-5". */
  model: string;
  apiKey: string;
  /** Only set for OpenAI-compatible providers. */
  baseURL?: string;
}

// Kept as the default so existing installs keep working untouched: this is the
// model the prompts and the executor's schema handling were tuned against.
const DEFAULT_SPEC = "fireworks/accounts/fireworks/models/kimi-k2p7-code";

/**
 * Splits "provider/model" on the FIRST slash only — model ids routinely contain
 * slashes ("accounts/fireworks/models/kimi-k2p7-code", "moonshotai/kimi-k2").
 * A spec whose first segment isn't a known provider is treated as a bare
 * Fireworks model id, which is what GREENLIGHT_MODEL meant before providers
 * were selectable.
 */
function parseSpec(raw: string): { provider: Provider; model: string } {
  const slash = raw.indexOf("/");
  if (slash > 0) {
    const head = raw.slice(0, slash);
    if (isProvider(head)) return { provider: head, model: raw.slice(slash + 1) };
  }
  return { provider: "fireworks", model: raw };
}

function resolveBaseURL(provider: Provider): string | undefined {
  if (!isCompatible(provider)) return undefined;
  return process.env.GREENLIGHT_LLM_BASE_URL || COMPATIBLE[provider].baseURL;
}

/**
 * Resolves one spec string into everything needed to reach the model. Returns
 * null (after explaining why) when it can't be used, so callers can stay
 * silent rather than fail the run.
 */
export function resolveModel(raw: string, label: string): ModelSpec | null {
  const { provider, model } = parseSpec(raw.trim());
  if (!model) {
    console.warn(`${label}: no model in "${raw}" — expected "provider/model".`);
    return null;
  }
  const baseURL = resolveBaseURL(provider);
  // One key setting for every provider: the provider is chosen by the model
  // spec, so a second, provider-named source could only ever disagree with it —
  // and the losing side would be a credential silently sent to the wrong host.
  const apiKey = process.env.GREENLIGHT_LLM_API_KEY ?? "";
  if (!apiKey) {
    console.warn(
      `${label}: no API key for "${provider}" — pass it via the Action's ` +
        `\`llm-api-key\` input, or set GREENLIGHT_LLM_API_KEY in the environment.`,
    );
    return null;
  }
  return { provider, model, apiKey, baseURL };
}

/** The model that turns PR context into a test plan. */
export function planModelSpec(): ModelSpec | null {
  return resolveModel(
    process.env.GREENLIGHT_MODEL || DEFAULT_SPEC,
    "test plan model",
  );
}

/** The model that drives and judges browser steps. Falls back to the plan
 *  model so one setting moves the whole pipeline; override only when the two
 *  should differ (e.g. a cheaper model for the many act/extract calls). */
export function executorModelSpec(): ModelSpec | null {
  const raw = process.env.GREENLIGHT_EXECUTOR_MODEL;
  return raw ? resolveModel(raw, "executor model") : planModelSpec();
}

// The default escalation model for a Fireworks install: vision-capable, and on
// the same key and host as the default plan model. Only ever reached for a
// Fireworks executor — see below.
const FIREWORKS_VISION_MODEL = "fireworks/accounts/fireworks/models/kimi-k3";

/**
 * The model that re-judges an item from a screenshot when the DOM couldn't
 * settle it. Null disables the escalation, leaving those items "uncertain".
 *
 * Left unset, this only ever picks a model on the provider already in use:
 * the executor itself where it can see (every native provider can), and the
 * Fireworks vision model for a Fireworks executor, since that provider's
 * default is a text-only coding model. It must never reach for some other
 * vendor's endpoint on its own — one key setting feeds every provider here, so
 * a cross-provider default would send the user's key to a host they never
 * chose. Any other provider gets the escalation only by asking for it.
 */
export function visualJudgeModelSpec(executor: ModelSpec): ModelSpec | null {
  const raw = (process.env.GREENLIGHT_VISUAL_JUDGE_MODEL ?? "").trim();
  if (raw === "off") return null;
  if (raw) return resolveModel(raw, "visual judge model");
  if (isNative(executor.provider)) return executor;
  if (executor.provider === "fireworks") {
    return resolveModel(FIREWORKS_VISION_MODEL, "visual judge model");
  }
  console.log(
    `no visual judge: "${executor.provider}" has no default vision model. Set ` +
      `GREENLIGHT_VISUAL_JUDGE_MODEL to one that can see (any provider) to have ` +
      `screenshots settle expectations the DOM can't.`,
  );
  return null;
}

/** An ai@7 model for our own generateText call. */
export function languageModel(spec: ModelSpec): LanguageModel {
  if (isNative(spec.provider)) {
    return NATIVE[spec.provider].create(spec.apiKey)(spec.model);
  }
  return createOpenAICompatible({
    name: spec.provider,
    baseURL: spec.baseURL!,
    apiKey: spec.apiKey,
    supportsStructuredOutputs: structuredOutputs(spec),
  }).chatModel(spec.model);
}

/** Whether to send a JSON schema the host is expected to enforce at decode
 *  time. `GREENLIGHT_LLM_STRUCTURED_OUTPUTS=1|0` overrides the table for hosts
 *  we haven't characterized. */
function structuredOutputs(spec: ModelSpec): boolean {
  const override = process.env.GREENLIGHT_LLM_STRUCTURED_OUTPUTS;
  if (override === "1") return true;
  if (override === "0") return false;
  if (isNative(spec.provider)) return true;
  return COMPATIBLE[spec.provider].structuredOutputs;
}

/** Coordinates for Stagehand's own provider stack (its bundled ai@5). We hand
 *  it a "prefix/model" string plus credentials rather than a model instance —
 *  injecting one crosses a major version boundary and breaks at runtime. */
export function stagehandModelConfig(spec: ModelSpec): {
  modelName: string;
  apiKey: string;
  baseURL?: string;
} {
  if (isNative(spec.provider)) {
    return { modelName: `${spec.provider}/${spec.model}`, apiKey: spec.apiKey };
  }
  const { prefix, passBaseURL } = COMPATIBLE[spec.provider].stagehand;
  return {
    modelName: `${prefix}/${spec.model}`,
    apiKey: spec.apiKey,
    ...(passBaseURL ? { baseURL: spec.baseURL } : {}),
  };
}

// Stagehand only adds its prompt-based JSON fallback for model ids matching
// these families, and its per-provider structured-output options are keyed on
// providers it knows natively — so a model behind the generic OpenAI-compatible
// route gets neither, and may free-guess the act/extract schema.
const PROMPT_JSON_FALLBACK = ["kimi", "deepseek", "glm"];

/** Non-null when the executor model is likely to produce schema-invalid
 *  act/extract output. Advisory: plenty of models do fine, but a mid-run Zod
 *  failure reads as a broken preview, so say it up front. */
export function executorSchemaWarning(spec: ModelSpec): string | null {
  if (isNative(spec.provider)) return null;
  const prefix = COMPATIBLE[spec.provider].stagehand.prefix;
  if (prefix !== "togetherai") return null;
  const id = spec.model.toLowerCase();
  if (PROMPT_JSON_FALLBACK.some((family) => id.includes(family))) return null;
  return (
    `executor model "${spec.model}" runs through an OpenAI-compatible endpoint, ` +
    `where Stagehand enforces its act/extract schemas only for the ` +
    `${PROMPT_JSON_FALLBACK.join("/")} families. If steps fail on malformed ` +
    `output, use one of those or switch to a native provider ` +
    `(${(Object.keys(NATIVE) as string[]).join(", ")}).`
  );
}

export function describe(spec: ModelSpec): string {
  return `${spec.provider}/${spec.model}`;
}
