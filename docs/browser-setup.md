# Browser setup

Describe what needs to happen before testing. Greenlight writes and verifies a
small Playwright hook for you. You do not need to write code.

## Create setup

```text
/greenlight init https://preview.example.com "Tick the acknowledgment checkbox and click Continue."
```

In Codex, use `$greenlight init` with the same preview URL and instructions.
If you omit the instructions, the skill asks what needs to happen before
Greenlight can test the app. No repository URL is needed.

Greenlight opens the preview in fresh local Chrome, reads the visible UI's
accessibility snapshot, and generates only the actions you requested. It runs
the candidate, checks the resulting UI against your instructions, and verifies
that the hook also works on the prepared page and after a reload. Later screens
can inform a revised candidate. Generation stops after six model responses if
it cannot verify the workflow.

Only a successfully verified hook is saved to `~/.greenlight/setup.ts`. A failed
attempt leaves your previous hook unchanged. Missing credentials, inaccessible
previews, and unspecified choices are reported so you can provide the missing
information. Setup does not inherit your everyday browser's signed-in session.

Initialization uses your current agent subscription. Your instructions, existing
hook, and preview accessibility snapshots are sent to that backend. It does not
scan repository files or invent unrelated login or onboarding steps.

## Change setup with a prompt

```text
/greenlight init https://preview.example.com "Also select the demo workspace after continuing."
```

Greenlight uses the existing hook and the new instructions to generate and
verify a replacement. To remove a behavior, say so in the instructions. You do
not need to edit the saved file yourself.

One personal hook applies to every local check, regardless of repository or
working directory. When switching apps, explicitly ask to replace the old setup
with the new app's prerequisites. The GitHub Action does not load this file.

## Execution

For each check, Greenlight navigates to the check's route, runs the saved hook
on that exact browser tab, then starts the generated test steps. Checks share
one browser session, so hooks must handle already-completed setup. There are
no model calls for setup during checks. Setup UI interactions appear in the
replay when recording is enabled.

An exception or the 30-second setup deadline marks the check inconclusive with
`Setup blocked` and stops the remaining checks. On timeout, Greenlight closes
the page to cancel pending actions. Run `init` with updated instructions to fix
a hook when the app's UI changes.

A missing hook preserves the normal flow. An empty, unreadable, oversized, or
invalid hook blocks execution. Existing `setup.yaml` and `setup.md` files are
not executed or silently ignored: run `init` with the preview and setup
instructions to migrate. The original files remain untouched; the new verified
Playwright hook takes precedence.

## Saved hook format

This is a small async function using Playwright locators, not a Playwright Test
suite. Greenlight owns the browser and provides `page`. For example, a generated
hook could look like this when these labels are observed in the preview:

```ts
export default async function setup({ page }) {
  const dialog = page.getByRole("dialog", { name: "Welcome" });
  const ready = page.getByRole("navigation", { name: "Console" });
  await dialog.or(ready).first().waitFor({ state: "visible" });
  if (await dialog.isVisible()) {
    await dialog.getByRole("checkbox", { name: "I acknowledge" }).check();
    await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  }
  await ready.waitFor({ state: "visible" });
}
```

The `.ts` file uses JavaScript-compatible syntax. Hooks support `const`, `if`,
`return`, locator composition, awaited UI actions, and explicit readiness waits.
Imports, helper functions, loops, `test()` fixtures, page evaluation, direct
network/storage access, and browser lifecycle operations are rejected. All UI
actions must be awaited. Hooks are limited to 8000 bytes and 100 lines; most
setups should need only a few lines per requested action.

Verification demonstrates the observed preview states, not every future route
or UI change. Include any route-specific prerequisites in your instructions.
