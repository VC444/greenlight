import type { Page } from "playwright-core";

export type SemanticRole = "link" | "button" | "checkbox" | "textbox" | "heading" | "text";

export interface SemanticTarget {
  role: SemanticRole;
  name: string;
  exact: true;
}

export interface BrowserDiagnostic {
  phase: "condition" | "action";
  strategy: "semantic_locator" | "stagehand_ai";
  instruction: string;
  outcome:
    | "satisfied"
    | "unsatisfied"
    | "unknown"
    | "completed"
    | "unsupported"
    | "action_failed";
  target?: SemanticTarget;
  matchCount?: number;
  visibleCount?: number;
  reason?: string;
  durationMs: number;
  attempts?: number;
}

export interface SemanticDecision {
  status: "satisfied" | "unsatisfied" | "unknown";
  reason: string;
}

interface CompiledCondition {
  target: SemanticTarget;
  visible: boolean;
}

const QUOTED = `(?:"(?<double>[^"]+)"|'(?<single>[^']+)')`;

function quotedValue(match: RegExpMatchArray): string {
  return (match.groups?.double ?? match.groups?.single ?? "").trim();
}

function roleFor(value: string): SemanticRole | null {
  switch (value.toLowerCase()) {
    case "link": return "link";
    case "button": return "button";
    case "checkbox": return "checkbox";
    case "field":
    case "input":
    case "textbox": return "textbox";
    case "heading": return "heading";
    case "text": return "text";
    default: return null;
  }
}

export function compileSemanticCondition(instruction: string): CompiledCondition | null {
  const normalized = instruction.trim();
  let match = normalized.match(new RegExp(`^The\\s+(?<role>link|button|checkbox|field|input|textbox|heading)\\s+(?:labeled|named)\\s+${QUOTED}\\s+is\\s+(?<state>visible|not visible|absent)\\.?$`, "i"));
  if (match?.groups?.role && match.groups.state) {
    const role = roleFor(match.groups.role);
    if (!role) return null;
    return { target: { role, name: quotedValue(match), exact: true }, visible: match.groups.state.toLowerCase() === "visible" };
  }
  match = normalized.match(new RegExp(`^The\\s+(?<role>text|heading)\\s+${QUOTED}\\s+is\\s+(?<state>visible|not visible|absent)\\.?$`, "i"));
  if (match?.groups?.role && match.groups.state) {
    const role = roleFor(match.groups.role);
    if (!role) return null;
    return { target: { role, name: quotedValue(match), exact: true }, visible: match.groups.state.toLowerCase() === "visible" };
  }
  match = normalized.match(new RegExp(`^${QUOTED}\\s+is\\s+(?<state>visible|not visible|absent)\\.?$`, "i"));
  if (match?.groups?.state) {
    return { target: { role: "text", name: quotedValue(match), exact: true }, visible: match.groups.state.toLowerCase() === "visible" };
  }
  return null;
}

// Setup owns the polling deadline. Each inspection reads current locator state
// without model inference or a second independent timeout.
export function createSemanticDriver(
  page: Pick<Page, "getByRole" | "getByText">,
  record: (diagnostic: BrowserDiagnostic) => void,
): { inspect: (instruction: string) => Promise<SemanticDecision | null> } {
  return {
    async inspect(instruction) {
      const started = performance.now();
      const compiled = compileSemanticCondition(instruction);
      if (!compiled) {
        record({ phase: "condition", strategy: "semantic_locator", instruction,
          outcome: "unsupported", durationMs: Math.round(performance.now() - started) });
        return null;
      }
      const { target } = compiled;
      const locator = target.role === "text"
        ? page.getByText(target.name, { exact: true })
        : page.getByRole(target.role, { name: target.name, exact: true, includeHidden: true });
      const matchCount = await locator.count();
      const visibleCount = await locator.filter({ visible: true }).count();
      const satisfied = compiled.visible ? visibleCount > 0 : visibleCount === 0;
      const reason = `Matches: ${matchCount}; visible: ${visibleCount}.`;
      record({ phase: "condition", strategy: "semantic_locator", instruction,
        outcome: satisfied ? "satisfied" : "unsatisfied", target,
        matchCount, visibleCount, reason,
        durationMs: Math.round(performance.now() - started) });
      return { status: satisfied ? "satisfied" : "unsatisfied", reason };
    },
  };
}
