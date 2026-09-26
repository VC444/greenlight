import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BrowserDiagnostic {
  phase: "condition" | "action";
  strategy: "stagehand_ai";
  instruction: string;
  outcome:
    | "satisfied"
    | "unsatisfied"
    | "unknown"
    | "completed"
    | "action_failed";
  reason?: string;
  durationMs: number;
  scope?: "setup" | "starting_state" | "check";
  step?: number;
  errorStack?: string;
  attempts?: number;
}


/** Sanitize diagnostic text before it reaches logs or local artifacts. */
export function diagnosticText(value: string): string {
  let text = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (/token|secret|password|api_?key|authorization|cookie/i.test(key) && secret && secret.length >= 4) {
      text = text.split(secret).join("[REDACTED]");
    }
  }
  return text
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/([?&][^=\s&]+)=([^&#\s]*)/g, "$1=[REDACTED]")
    .replace(/(Bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:password|token|secret|api[_-]?key|authorization|cookie)\s*[:=]\s*)[^\n,;]+/gi, "$1[REDACTED]");
}

/** Local companion to the replay. Never include environment or auth configuration. */
export async function writeDiagnostics(directory: string, data: unknown): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "diagnostics.json");
  const json = JSON.stringify(data, (_key, value) =>
    typeof value === "string" ? diagnosticText(value) : value, 2);
  await writeFile(file, json + "\n", { encoding: "utf8", mode: 0o600 });
  return file;
}

export interface StagehandCall {
  method: "act" | "extract" | "observe" | "agent";
  instruction: string;
  schema?: string;
  startedAt: string;
  durationMs: number;
  status: "returned" | "threw";
  result?: unknown;
  error?: { message: string; stack?: string };
}

/** Preserve the API response, including unsuccessful act results, without retrying. */
export async function traceStagehandCall<T>(
  calls: StagehandCall[],
  input: Pick<StagehandCall, "method" | "instruction" | "schema">,
  invoke: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const result = await invoke();
    calls.push({ ...input, startedAt, durationMs: Math.round(performance.now() - started),
      status: "returned", result });
    return result;
  } catch (error) {
    calls.push({ ...input, startedAt, durationMs: Math.round(performance.now() - started),
      status: "threw", error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      } });
    throw error;
  }
}
