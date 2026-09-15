import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LLMClient,
  toJsonSchema,
  type ChatMessage,
  type CreateChatCompletionOptions,
  type LLMParsedResponse,
  type LLMResponse,
  type StagehandZodSchema,
} from "@browserbasehq/stagehand";

export type SubscriptionBackend = "codex" | "claude";

type SubscriptionFailure =
  | "exit"
  | "invalid-json"
  | "missing-output"
  | "structured-retries"
  | "cli-error"
  | "unsupported-option"
  | "unsupported-schema"
  | "authentication"
  | "timeout"
  | "output-limit"
  | "input-closed"
  | "spawn";

// Only fixed diagnostic text crosses into the user-facing report.
export class SubscriptionRequestError extends Error {
  constructor(backend: SubscriptionBackend, reason: SubscriptionFailure, code?: number | null) {
    const detail: Record<SubscriptionFailure, string> = {
      exit: code == null ? "exited without an exit code" : `failed with exit code ${code}`,
      "invalid-json": "returned invalid JSON",
      "missing-output": "returned no structured output",
      "structured-retries": "reached its structured output retry limit",
      "cli-error": "reported a model request error",
      "unsupported-option": "rejected a CLI option; check the installed Claude Code version",
      "unsupported-schema": "rejected the JSON schema; check compatibility with the installed Claude Code version",
      authentication: "could not access authentication; check your gateway credentials if configured, otherwise run `claude auth login` in the terminal used to launch Greenlight",
      timeout: "timed out while generating a response",
      "output-limit": "exceeded Greenlight's response size limit",
      "input-closed": "closed stdin before accepting the full request",
      spawn: "could not start; check that its CLI is available to Greenlight",
    };
    super(`${backend === "claude" ? "Claude Code" : "Codex"} ${detail[reason]}.`);
    this.name = "SubscriptionRequestError";
  }
}

class ProcessFailure extends Error {
  constructor(readonly reason: "timeout" | "output-limit" | "input-closed") {
    super(reason);
  }
}

export interface ProcessRequest {
  file: string;
  args: string[];
  cwd: string;
  input?: string;
  timeoutMs?: number;
}

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (
  request: ProcessRequest,
) => Promise<ProcessResult>;

export interface ImageInput {
  data: Buffer;
  extension: "jpeg" | "png";
}

export interface SubscriptionJsonRequest {
  system?: string;
  prompt: string;
  schema: unknown;
  images?: ImageInput[];
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

function claudeGatewayConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_BASE_URL?.trim() &&
    (process.env.ANTHROPIC_AUTH_TOKEN?.trim() || process.env.ANTHROPIC_API_KEY?.trim()));
}

function subscriptionEnvironment(file: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const gateway = file === "claude" && claudeGatewayConfigured();
  for (const name of [
    ...(gateway ? [] : ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]),
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "OPENAI_API_KEY",
  ]) {
    delete env[name];
  }
  return env;
}

export async function runProcess(
  request: ProcessRequest,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(request.file, request.args, {
      cwd: request.cwd,
      env: subscriptionEnvironment(request.file),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputTooLarge = false;
    let timedOut = false;
    let inputError: Error | undefined;

    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) + chunk.byteLength > MAX_OUTPUT_BYTES) {
        outputTooLarge = true;
        child.kill("SIGTERM");
        return current;
      }
      return current + chunk.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      inputError = error;
      // An early CLI exit can close stdin before the prompt finishes writing.
      // Wait for close so its exit status and diagnostics are preserved.
      if (error.code !== "EPIPE") child.kill("SIGTERM");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();

    child.once("close", (code) => {
      clearTimeout(timer);
      if (outputTooLarge) {
        reject(new ProcessFailure("output-limit"));
        return;
      }
      if (timedOut) {
        reject(new ProcessFailure("timeout"));
        return;
      }
      if (inputError && code === 0) {
        reject(new ProcessFailure("input-closed"));
        return;
      }
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(request.input);
  });
}

export function subscriptionBackend(
  env: NodeJS.ProcessEnv = process.env,
): SubscriptionBackend | null {
  const value = env.GREENLIGHT_LOCAL_AGENT?.trim();
  if (!value) return null;
  if (value === "codex" || value === "claude") return value;
  throw new Error(
    `Unsupported local agent "${value}". Expected codex or claude.`,
  );
}

export async function validateSubscriptionAuth(
  backend: SubscriptionBackend,
  runner: ProcessRunner = runProcess,
): Promise<void> {
  // Gateway credentials are validated by the model request, not subscription login.
  if (backend === "claude" && claudeGatewayConfigured()) return;
  const cwd = os.tmpdir();
  let result: ProcessResult;
  try {
    result =
      backend === "codex"
        ? await runner({ file: "codex", args: ["login", "status"], cwd })
        : await runner({
            file: "claude",
            args: ["auth", "status", "--json"],
            cwd,
          });
  } catch {
    throw new Error(
      backend === "codex"
        ? "Codex CLI was not found. Install it, then run `codex login`."
        : "Claude Code was not found. Install it, then run `claude auth login`.",
    );
  }

  if (backend === "codex") {
    const statusOutput = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0 && /Logged in using ChatGPT/i.test(statusOutput)) {
      return;
    }
    throw new Error(
      "Codex CLI is not signed in with a ChatGPT subscription. Run `codex login` and choose ChatGPT sign-in.",
    );
  }

  try {
    const status = JSON.parse(result.stdout) as { loggedIn?: boolean };
    if (result.code === 0 && status.loggedIn) return;
  } catch {
    // Report the same safe authentication error below.
  }
  throw new Error(
    "Claude Code is not signed in with a Claude subscription. Run `claude auth login` and try again.",
  );
}

function cleanJson(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  return JSON.parse(unfenced);
}

function claudeStructuredOutput(result: ProcessResult): unknown {
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      envelope = parsed as Record<string, unknown>;
    }
  } catch {
    // Classify invalid output without including it in the error.
  }
  if (result.code !== 0 || envelope?.is_error === true) {
    if (envelope?.subtype === "error_max_structured_output_retries") {
      throw new SubscriptionRequestError("claude", "structured-retries");
    }
    if (/unknown option|unrecognized option/i.test(result.stderr)) {
      throw new SubscriptionRequestError("claude", "unsupported-option");
    }
    if (/--json-schema is not a valid JSON Schema/i.test(result.stderr)) {
      throw new SubscriptionRequestError("claude", "unsupported-schema");
    }
    // Inspect only failure diagnostics and emit fixed text, never CLI output.
    const diagnostics = [
      result.stderr,
      typeof envelope?.result === "string" ? envelope.result : "",
      ...(Array.isArray(envelope?.errors)
        ? envelope.errors.filter((value): value is string => typeof value === "string")
        : []),
    ].join("\n");
    if (/\bnot logged in\b/i.test(diagnostics)) {
      throw new SubscriptionRequestError("claude", "authentication");
    }
    throw new SubscriptionRequestError(
      "claude", result.code === 0 ? "cli-error" : "exit", result.code,
    );
  }
  if (!envelope) throw new SubscriptionRequestError("claude", "invalid-json");
  if (envelope.structured_output !== undefined) return envelope.structured_output;
  if (typeof envelope.result === "string" && envelope.result) {
    try {
      return cleanJson(envelope.result);
    } catch {
      throw new SubscriptionRequestError("claude", "invalid-json");
    }
  }
  throw new SubscriptionRequestError("claude", "missing-output");
}

function renderMessages(messages: ChatMessage[]): {
  prompt: string;
  images: ImageInput[];
} {
  const images: ImageInput[] = [];
  const sections = messages.map((message) => {
    const content = Array.isArray(message.content)
      ? message.content
          .map((part) => {
            if (part.text) return part.text;
            const dataUrl =
              "image_url" in part ? part.image_url?.url : undefined;
            const source = "source" in part ? part.source : undefined;
            if (dataUrl?.startsWith("data:image/")) {
              const match = dataUrl.match(
                /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/,
              );
              if (match?.[1] && match[2]) {
                images.push({
                  data: Buffer.from(match[2], "base64"),
                  extension: match[1] as "jpeg" | "png",
                });
                return `[Attached image ${images.length}]`;
              }
            }
            if (source?.type === "base64" && source.data) {
              images.push({
                data: Buffer.from(source.data, "base64"),
                extension: source.media_type === "image/jpeg" ? "jpeg" : "png",
              });
              return `[Attached image ${images.length}]`;
            }
            return "[Image unavailable]";
          })
          .join("\n")
      : message.content;
    return `${message.role.toUpperCase()}:\n${content}`;
  });
  return { prompt: sections.join("\n\n"), images };
}

function modelArgs(backend: SubscriptionBackend): string[] {
  const model =
    backend === "codex"
      ? process.env.GREENLIGHT_CODEX_MODEL?.trim()
      : process.env.GREENLIGHT_CLAUDE_MODEL?.trim();
  return model ? ["--model", model] : [];
}

export async function runSubscriptionJson<T>(
  backend: SubscriptionBackend,
  request: SubscriptionJsonRequest,
  runner: ProcessRunner = runProcess,
): Promise<T> {
  const execute: ProcessRunner = async (processRequest) => {
    try {
      return await runner(processRequest);
    } catch (error) {
      throw new SubscriptionRequestError(
        backend, error instanceof ProcessFailure ? error.reason : "spawn",
      );
    }
  };
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "greenlight-model-"));
  try {
    const schemaFile = path.join(tempDir, "schema.json");
    const outputFile = path.join(tempDir, "output.json");
    await writeFile(schemaFile, JSON.stringify(request.schema), "utf8");

    const imagePaths: string[] = [];
    for (const [index, image] of (request.images ?? []).entries()) {
      const imagePath = path.join(tempDir, `image-${index + 1}.${image.extension}`);
      await writeFile(imagePath, image.data);
      imagePaths.push(imagePath);
    }

    const imageNote = imagePaths.length
      ? `\n\nInspect the attached image file${imagePaths.length === 1 ? "" : "s"}:\n${imagePaths.join("\n")}`
      : "";
    const prompt = [
      "You are a deterministic model component inside Greenlight.",
      "Use only the supplied conversation and attached images.",
      "Return only the JSON value required by the supplied schema.",
      request.system,
      request.prompt,
      imageNote,
    ]
      .filter(Boolean)
      .join("\n\n");

    if (backend === "codex") {
      const args = [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--output-schema",
        schemaFile,
        "--output-last-message",
        outputFile,
        ...modelArgs(backend),
      ];
      for (const imagePath of imagePaths) args.push("--image", imagePath);
      args.push("-");
      const result = await execute({
        file: "codex",
        args,
        cwd: tempDir,
        input: prompt,
      });
      if (result.code !== 0) {
        throw new SubscriptionRequestError("codex", "exit", result.code);
      }
      return cleanJson(await readFile(outputFile, "utf8")) as T;
    }

    // Claude 2.1.205 rejects Zod's 2020-12 dialect declaration before inference.
    // Copy only the root so constraints and properties named $schema stay intact.
    let claudeSchema = request.schema;
    if (request.schema && typeof request.schema === "object" && !Array.isArray(request.schema)) {
      const copy = { ...request.schema } as Record<string, unknown>;
      delete copy.$schema;
      claudeSchema = copy;
    }
    const args = [
      "-p",
      "--safe-mode",
      "--no-session-persistence",
      "--permission-mode",
      "dontAsk",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(claudeSchema),
      "--tools",
      imagePaths.length ? "Read" : "",
      ...modelArgs(backend),
    ];
    if (imagePaths.length) args.push("--add-dir", tempDir);
    const result = await execute({
      file: "claude",
      args,
      cwd: tempDir,
      input: prompt,
    });
    return claudeStructuredOutput(result) as T;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

const EMPTY_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

export class SubscriptionLLMClient extends LLMClient {
  type = "subscription-cli" as const;
  hasVision = true;
  clientOptions = {};

  constructor(
    private readonly backend: SubscriptionBackend,
    private readonly query: typeof runSubscriptionJson = runSubscriptionJson,
  ) {
    super(`${backend}-subscription` as never);
  }

  async createChatCompletion<T>(
    request: CreateChatCompletionOptions & {
      options: {
        response_model: {
          name: string;
          schema: StagehandZodSchema;
        };
      };
    },
  ): Promise<LLMParsedResponse<T>>;
  async createChatCompletion<T = LLMResponse>(
    request: CreateChatCompletionOptions,
  ): Promise<T>;
  async createChatCompletion<T>(
    request: CreateChatCompletionOptions,
  ): Promise<T | LLMParsedResponse<T>> {
    const { prompt, images } = renderMessages(request.options.messages);
    if (request.options.image) {
      images.push({ data: request.options.image.buffer, extension: "png" });
    }
    const responseModel = request.options.response_model;
    if (!responseModel) {
      throw new Error(
        "The subscription CLI backend requires structured Stagehand requests.",
      );
    }
    const raw = await this.query<T>(this.backend, {
      prompt,
      schema: toJsonSchema(responseModel.schema),
      images,
    });
    const data = responseModel.schema.parse(raw) as T;
    return { data, usage: EMPTY_USAGE };
  }
}
