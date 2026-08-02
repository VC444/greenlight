import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { config } from "./config.js";

/**
 * Session recording for a browser run, as rrweb events.
 *
 * rrweb captures DOM mutations and input events rather than pixels, so a run is
 * tens of kilobytes of JSON instead of megabytes of video — which is what makes
 * it viable as a CI artifact — and the replay re-renders the same DOM the judge
 * ruled on rather than showing pixels the judge never saw.
 *
 * Recording is off unless GREENLIGHT_REPLAY_DIR is set, so the App path and
 * local runs are unaffected until they ask for it.
 */

const require_ = createRequire(import.meta.url);

/**
 * Reads a file out of a package's dist directory. rrweb's "exports" map only
 * publishes its main entry, so a deep specifier can't be resolved directly —
 * resolve the entry and walk to its sibling instead.
 */
function distFile(pkg: string, file: string): string {
  return readFileSync(path.join(path.dirname(require_.resolve(pkg)), file), "utf8");
}

/** One plan item's recording. */
export interface ItemRecording {
  intent: string;
  route: string;
  events: unknown[];
}

export function isRecording(): boolean {
  return config.replayDir !== "";
}

let initScript: string | undefined;

/**
 * Injected before any page script runs, so the recorder is attached before the
 * app can mutate anything. Runs on every navigation — which is why events are
 * drained per item rather than accumulated across the whole run.
 *
 * Failure here is swallowed: a missing recording is a worse outcome than a
 * failed run, but only slightly, and never worth losing verdicts over.
 */
export function recorderInitScript(): string {
  initScript ??= `${distFile("rrweb", "rrweb.umd.min.cjs")}
;(() => {
  // Top frame only. Init scripts run in every frame, but drainEvents only ever
  // reads the main frame's buffer, so recording in subframes captures nothing
  // anyone collects — and empirically it can wedge an iframe mid-load, which
  // blocks the parent's load event forever (a parent only fires load once
  // every subframe has finished).
  if (window !== window.top) return;
  if (window.__greenlightEvents) return;
  window.__greenlightEvents = [];
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    try {
      rrweb.record({
        emit: (event) => { window.__greenlightEvents.push(event); },
        inlineImages: ${config.replayInlineImages},
      });
    } catch (error) {
      console.warn("greenlight: could not start session recording", error);
    }
  };
  // Never start recording before the page has loaded: rrweb.record() running
  // during hydration keeps the load event from ever firing (bisected on a
  // Next.js preview — images hang, the driver's settle wait deadlocks). After
  // load, the initial snapshot captures the fully rendered page, and recording
  // is live before any plan step runs. The timeout is a fallback so a page
  // that never fires load still gets recorded, just late.
  if (document.readyState === "complete") start();
  else {
    window.addEventListener("load", start);
    setTimeout(start, 15000);
  }
})();`;
  return initScript;
}

// The evaluate below can block indefinitely when the page never settles (e.g.
// its load event never fired and the driver gates evaluate on load state) —
// and a hung drain would hang the whole run. Recording is never worth that:
// give up after this budget and move on without the item's events.
const DRAIN_TIMEOUT_MS = 10_000;

/** Takes the events recorded since the last drain, and clears the buffer. */
export async function drainEvents(
  page: { evaluate<R>(expression: string): Promise<R> },
): Promise<unknown[]> {
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), DRAIN_TIMEOUT_MS).unref();
  });
  try {
    const events = await Promise.race([
      page.evaluate<unknown[]>(
        `(() => { const e = window.__greenlightEvents || []; window.__greenlightEvents = []; return e; })()`,
      ),
      timeout,
    ]);
    if (events === "timeout") {
      console.warn(
        `greenlight: reading the session recording timed out after ${DRAIN_TIMEOUT_MS}ms — skipping this item's events`,
      );
      return [];
    }
    return events;
  } catch (error) {
    console.warn(
      "greenlight: could not read session recording:",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

// Embedded JSON sits inside a <script> tag, where a literal "</script>" in any
// captured text content would close it early and break the page.
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function renderPlayer(recordings: ItemRecording[]): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>Greenlight — session replay</title>
<style>
${distFile("rrweb", "style.min.css")}
${distFile("rrweb-player", "style.min.css")}
body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0f1115; color: #e6e8eb; }
header { padding: 16px 20px; border-bottom: 1px solid #232733; }
h1 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
p { margin: 0; color: #9aa4b2; font-size: 13px; }
nav { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 20px; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer;
  background: #1a1e27; color: #e6e8eb; border: 1px solid #2b3140; }
button[aria-pressed="true"] { background: #1f6feb; border-color: #1f6feb; }
main { padding: 0 20px 24px; }
.empty { color: #9aa4b2; padding: 24px 0; }
</style>
<header>
  <h1>Greenlight — session replay</h1>
  <p>One recording per plan item. Playback re-renders the page's DOM, so text stays sharp and selectable.</p>
</header>
<nav id="picker"></nav>
<main id="stage"></main>
<script>${distFile("rrweb-player", "rrweb-player.umd.min.cjs")}</script>
<script>
const RECORDINGS = ${embed(recordings)};
const Player = window.rrwebPlayer && (window.rrwebPlayer.default || window.rrwebPlayer);
const picker = document.getElementById("picker");
const stage = document.getElementById("stage");

function show(index) {
  stage.innerHTML = "";
  for (const button of picker.children) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.index) === index));
  }
  const recording = RECORDINGS[index];
  // rrweb needs a full snapshot plus at least one change to play anything.
  if (!recording || !Array.isArray(recording.events) || recording.events.length < 2) {
    stage.innerHTML = '<p class="empty">No recording was captured for this item.</p>';
    return;
  }
  new Player({
    target: stage,
    props: {
      events: recording.events,
      autoPlay: false,
      width: Math.min(window.innerWidth - 40, 1280),
      height: 720,
    },
  });
}

RECORDINGS.forEach((recording, index) => {
  const button = document.createElement("button");
  button.textContent = (index + 1) + ". " + recording.intent;
  button.dataset.index = String(index);
  button.onclick = () => show(index);
  picker.appendChild(button);
});

if (RECORDINGS.length) show(0);
else stage.innerHTML = '<p class="empty">Nothing was recorded for this run.</p>';
</script>
`;
}

/**
 * Writes a single self-contained HTML file — player, styles and events all
 * inlined — so the artifact opens offline with nothing to install and no
 * network access. Returns the path, or null when there was nothing to write.
 */
export async function writeReplay(recordings: ItemRecording[]): Promise<string | null> {
  const withEvents = recordings.filter((r) => r.events.length > 0);
  if (!withEvents.length) {
    console.warn("greenlight: no rrweb events were captured — not writing a replay");
    return null;
  }

  try {
    await mkdir(config.replayDir, { recursive: true });
    const file = path.join(config.replayDir, "replay.html");
    await writeFile(file, renderPlayer(withEvents), "utf8");
    const events = withEvents.reduce((total, r) => total + r.events.length, 0);
    console.log(`wrote session replay to ${file} (${withEvents.length} item(s), ${events} events)`);
    return file;
  } catch (error) {
    console.warn(
      "greenlight: could not write session replay:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
