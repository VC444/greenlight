# Browser setup

Greenlight uses `.greenlight/setup.ts`, a standalone TypeScript module owned
by the app's repository. It exports an async function containing Playwright operations and readiness
checks written in code. Setup uses only Playwright. After it succeeds,
Stagehand executes the PR checks on the same page and browser session.

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
requires Chrome. It launches Playwright directly, without Stagehand, model
credentials, or a model subscription. Environment configuration can be supplied through `.env`.
It runs only setup, without generating a plan, making a model verdict, or
posting to GitHub. Errors exit unsuccessfully; success means the script returned
without throwing. The assertions in your script determine what readiness means.
A replay is written to `greenlight-replay` by default. Review it before committing.

## Hook contract

```ts
import type { Page } from "playwright-core";

type SetupContext = {
  page: Page;
  previewUrl: string;
  signal: AbortSignal;
};

export default async function setup({ page, signal }: SetupContext) {
  signal.throwIfAborted();
  const selector = page.getByRole("button", { name: /^Workspace:/ });
  await selector.waitFor({ state: "visible", timeout: 10_000 });

  if ((await selector.innerText()) !== "Workspace: Demo") {
    await selector.click({ timeout: 10_000 });
    signal.throwIfAborted();
    await page.getByRole("menuitem", { name: "Demo", exact: true })
      .click({ timeout: 10_000 });
  }

  signal.throwIfAborted();
  await page.getByRole("button", { name: "Workspace: Demo", exact: true })
    .waitFor({ state: "visible", timeout: 10_000 });
}

```

Use accessible names and expected values that match your app. This example
assumes the selector is named `Workspace: <name>` and opens a menu. Greenlight supplies
the live Playwright page, preview URL, and abort signal. The page is already at the preview entry point with replay
recording attached. Use this supplied page so setup and PR checks share state.
Do not start or close your own browser session. The setup hook receives no
Stagehand instance and must not make model calls.

The hook runs before each check in the shared session. Handle already-prepared
state. After common setup, Greenlight navigates to that check's route and applies
PR-specific preparation before exercising the changed behavior. All normal
setup interactions on the supplied page appear in the replay.

Prefer Playwright locators such as `getByRole`, `getByLabel`, and `getByTestId`.
Locator actions wait for actionability; use `waitFor` for readiness and explicit
operation timeouts within the hook deadline. Avoid fixed sleeps. Locator names
and test IDs need maintenance when the app changes.

The runtime supplies `playwright-core`, not the `@playwright/test` runner or its
`test` and `expect` APIs. Use locator waits and code assertions that throw on
failure. Playwright setup operations appear in the replay, but are not recorded
as individual Stagehand calls in diagnostics. Full PR runs use Stagehand for
browser launch and subsequent PR checks; setup itself uses only Playwright.
The standalone `setup-check` command launches Chrome through Playwright and
requires no model configuration.

## Loading and trust

For ordinary PR runs, Greenlight downloads `.greenlight/setup.ts` through the
GitHub Contents API using the PR event's exact `head.sha`. It uses the base
repository and never falls back to the base version or a workspace file. Logs show
the PR head revision. The existing `contents: read` permission is sufficient;
a caller checkout is not needed for setup.

A missing PR head script skips common setup. An empty, oversized, unreadable, or
invalid script does not run checks as if setup succeeded. Missing or invalid head revision
or API errors other than a missing file stop the pipeline. Scripts are limited
to 16000 UTF-8 bytes and must default-export a function. Syntax and export errors
are reported as Setup blocked when execution begins.

Only the single script is fetched. Keep it self-contained. Runtime imports may
use Node built-ins and the Action's installed dependencies. Repository-relative
helpers and the app's `node_modules` are not loaded. Type imports in the example
are erased at runtime; for editor typechecking, install the corresponding
dependencies in the app's development environment.

This is executable PR code with access to the runner environment, not a
sandbox. Keep secrets in environment variables, not in the script. Review setup
changes like other executable CI configuration. PR additions and edits to setup execute
in that PR run. Only run Greenlight with runner credentials appropriate for the
PR code you allow to execute. Use the local `setup-check` command to verify a
proposed script before pushing.

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
`run-context`. The planner reads the PR head script as context to avoid duplicating
its preparation; it never rewrites or regenerates the script.

Per-check preparation remains visible in the plan comment as Prepare, Ready,
and Equals lines. Missing prerequisites produce an explicit Blocked reason.
CI does not ask follow-up questions. Supply missing data and rerun, or correct
a paused plan before resuming it. External sign-in, MFA, backend seeding, and
account configuration must already be supported by your setup and environment.
Vercel deployment bypass does not sign into the application.

## Migration from YAML

The Action no longer loads `.greenlight/setup.yaml`. Rewrite its actions as
Playwright calls and its conditions as locator waits and code assertions in
`.greenlight/setup.ts`. Review and run `setup-check`, then merge the new script.
YAML files are preserved; there is no automatic conversion or deletion.

The paused local PR runner still accepts its personal `~/.greenlight/setup.yaml`
recipes. `greenlight init` now targets the repository's native setup; it does
not update the personal YAML file.
