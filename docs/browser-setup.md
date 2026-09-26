# Browser setup

Greenlight uses `.greenlight/setup.ts`, a standalone TypeScript module owned
by the app's repository. It exports an async function containing native
Stagehand calls, direct Playwright operations, and assertions written in code.

## Create and verify

Run `greenlight init` from the app's Git repository. The CLI finds the repository
root, even from a subdirectory, and creates a starter. Existing scripts are
preserved. The starter deliberately throws until preparation and readiness
checks have been filled in; scaffolding does not establish that the app is ready.
No model subscription or API key is needed to create the file.

For agent-assisted authoring, invoke `$greenlight init` in Codex or
`/greenlight init` in Claude Code from the app's repository. Describe what setup
should do and how to recognize success. The agent asks for missing details,
writes native code, and saves it for review. It does not regenerate the script
during subsequent PR runs. Developers can also write the file directly.

Test the reviewed working-tree script with:

```bash
greenlight setup-check https://preview.example
```

This command executes local repository code against the supplied preview. It
requires Chrome plus `GREENLIGHT_MODEL` and `GREENLIGHT_LLM_API_KEY` for
Stagehand inference. Environment configuration can be supplied through `.env`.
It runs only setup, without generating a plan, making a model verdict, or
posting to GitHub. Errors exit unsuccessfully; success means the script returned
without throwing. The assertions in your script determine what readiness means.
A replay is written to `greenlight-replay` by default. Review it before committing.

## Hook contract

```ts
import type { Stagehand } from "@browserbasehq/stagehand";
import type { Page } from "playwright-core";
import type { z as Zod } from "zod";

type SetupContext = {
  stagehand: Stagehand;
  page: Page;
  z: typeof Zod;
  previewUrl: string;
  signal: AbortSignal;
};

export default async function setup({ stagehand, page, z, signal }: SetupContext) {
  signal.throwIfAborted();
  const { workspace } = await stagehand.extract(
    "Extract the selected workspace name.",
    z.object({ workspace: z.string().nullable() }),
    { page },
  );

  if (workspace !== "Demo") {
    const opened = await stagehand.act("Click the workspace selector.", { page });
    if (!opened.success) throw new Error(opened.message);
    signal.throwIfAborted();
    const selected = await stagehand.act('Click "Demo".', { page });
    if (!selected.success) throw new Error(selected.message);
  }

  signal.throwIfAborted();
  const ready = await stagehand.extract(
    "Extract the selected workspace name.",
    z.object({ workspace: z.string().nullable() }),
    { page },
  );
  if (ready.workspace !== "Demo") throw new Error("Expected the Demo workspace.");
}
```

Use instructions and expected values that match your app. Greenlight supplies
the existing Stagehand instance, live Playwright page, Zod, preview URL, and
abort signal. The page is already at the preview entry point with replay
recording attached. Always pass `{ page }` to Stagehand calls so they operate
on the recorded page. Do not start or close your own browser or Stagehand session.

The hook runs before each check in the shared session. Handle already-prepared
state. After common setup, Greenlight navigates to that check's route and applies
PR-specific preparation before exercising the changed behavior. All normal
setup interactions on the supplied page appear in the replay.

Use native `act()`, `extract()`, `observe()`, or direct Playwright methods.
Check `act()` results for success. Throw when readiness is not established.
If a page needs time to settle, write explicit waits or polling in the script;
Greenlight adds no YAML translation, condition interpretation, or hidden retry
loop around your code. Extract facts and compare expected values in code.

## Loading and trust

For ordinary PR runs, Greenlight downloads `.greenlight/setup.ts` through the
GitHub Contents API using the PR event's exact `base.sha`. It uses the base
repository and never falls back to PR-head code or a workspace file. Logs show
the base revision. The existing `contents: read` permission is sufficient;
a caller checkout is not needed for setup.

A missing base script skips common setup. An empty, oversized, unreadable, or
invalid script does not run checks as if setup succeeded. Missing base revision
or API errors other than a missing file stop the pipeline. Scripts are limited
to 16000 UTF-8 bytes and must default-export a function. Syntax and export errors
are reported as Setup blocked when execution begins.

Only the single script is fetched. Keep it self-contained. Runtime imports may
use Node built-ins and the Action's installed dependencies. Repository-relative
helpers and the app's `node_modules` are not loaded. Type imports in the example
are erased at runtime; for editor typechecking, install the corresponding
dependencies in the app's development environment.

This is trusted executable code with access to the runner environment, not a
sandbox. Keep secrets in environment variables, not in the script. Review setup
changes like other executable CI configuration. PR edits to setup are not used
until merged. Use the explicitly invoked local `setup-check` command to verify
a proposed script before merging; ordinary PR runs have no override to execute
PR-head setup.

## Failure and timeout behavior

A thrown error leaves the affected check Inconclusive with `Setup blocked`.
A pending native setup invocation has a deadline of 60 seconds, including module
loading. Set `setup-timeout-seconds` from 1 to 300 to change it. On expiry,
Greenlight aborts the supplied signal, stops remaining checks, saves available
replay evidence, and closes the browser. Remaining checks become Inconclusive.
Check the signal between operations and pass it to cancellable operations.

JavaScript running synchronously cannot be interrupted by this asynchronous
deadline. Background work that ignores the signal is not forcibly terminated
by a promise timeout. Keep a job-level `timeout-minutes` as the final process
limit, and do not start background work that outlives the hook.

## PR-specific prerequisites

Shared preparation belongs in the committed script. Record names, reproduction
instructions, and other per-PR details belong in the PR description or
`run-context`. The planner reads the base script as context to avoid duplicating
its preparation; it never rewrites or regenerates the script.

Per-check preparation remains visible in the plan comment as Prepare, Ready,
and Equals lines. Missing prerequisites produce an explicit Blocked reason.
CI does not ask follow-up questions. Supply missing data and rerun, or correct
a paused plan before resuming it. External sign-in, MFA, backend seeding, and
account configuration must already be supported by your setup and environment.
Vercel deployment bypass does not sign into the application.

## Migration from YAML

The Action no longer loads `.greenlight/setup.yaml`. Rewrite its actions as
native calls and its conditions as extraction plus code assertions in
`.greenlight/setup.ts`. Review and run `setup-check`, then merge the new script.
YAML files are preserved; there is no automatic conversion or deletion.

The paused local PR runner still accepts its personal `~/.greenlight/setup.yaml`
recipes. `greenlight init` now targets the repository's native setup; it does
not update the personal YAML file.
