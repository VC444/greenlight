# Browser setup

The local skill can apply a personal setup workflow before each check, such as
dismissing a welcome dialog or selecting a workspace. The GitHub Action does
not load or apply this workflow.

## Create and review setup

Run `/greenlight init https://github.com/owner/repo` in Claude Code, or
`$greenlight init https://github.com/owner/repo` in Codex. Greenlight reads a
bounded selection of app entry routes and prerequisite source files from the
default branch, then saves a draft to `~/.greenlight/setup.yaml`.

The draft is inferred from source, not browser-verified. Review the actions,
conditions, deadlines, and assumptions before running checks. Credentials,
MFA, and external sign-in requirements need manual preparation. Running
`init` again displays your existing valid setup without overwriting edits.
You can also write the file yourself using the schema below.

The local skill reads this file automatically, regardless of the working
directory. One setup applies to every repository you check, so update it when
switching apps. The file stays outside your repository and is not shared with
teammates. Its contents are sent to your configured model backend for setup.

## Schema

Use version 1. Each step has a unique ID, a prerequisite, ordered actions, and
a postcondition. Conditions describe observable UI states; actions describe
individual unconditional UI interactions.

```yaml
version: 1
steps:
  - id: dismiss-welcome
    skip_if: >
      The console navigation is visible and usable,
      and the welcome dialog is absent.
    wait_for: >
      The welcome dialog containing
      "I acknowledge the above statements." is visible.
    timeout_ms: 10000
    actions:
      - Ensure "I acknowledge the above statements." is checked.
      - Click "Continue to Console".
    verify: >
      The welcome dialog is absent and
      the console navigation is visible and usable.
ready:
  condition: >
    The console navigation is visible and usable,
    with no dialog blocking interaction.
  timeout_ms: 10000
```

| Field | Meaning |
| --- | --- |
| `version` | Must be `1`. |
| `steps` | Ordered setup steps; may be empty when only readiness needs checking. |
| `steps[].id` | Unique identifier using letters, digits, underscores, or hyphens. |
| `steps[].skip_if` | Optional positive evidence that this step is already complete. Omit or use `null` for a required step. |
| `steps[].wait_for` | Visible prerequisite for executing the actions. |
| `steps[].timeout_ms` | Deadline applied separately to the skip observation, prerequisite, and postcondition. |
| `steps[].actions` | Nonempty list of individual UI actions executed in order. |
| `steps[].verify` | Visible postcondition required after all actions. |
| `ready.condition` | Final observable condition required before testing begins. |
| `ready.timeout_ms` | Deadline for the final readiness check. |

Choose conditions and deadlines appropriate for your app. An absent dialog
alone is insufficient evidence for `skip_if`; describe the usable app state
that confirms the step is already complete. Express waits in conditions and
make checkbox actions idempotent, such as ensuring a checkbox is selected.

Deadlines must be integers from 1 to 300000 milliseconds. Each deadline
includes model observation time. UI actions use the browser driver's action
timeout.

## Execution and failures

For each step, Greenlight evaluates `skip_if` once, if provided. It skips only
when that condition is positively verified. Otherwise it waits for
`wait_for`, executes each action in order, and waits for `verify`. Unsatisfied
or uncertain conditions are retried until their deadline. After every step
has completed or been explicitly skipped, Greenlight evaluates `ready`.
Natural-language conditions depend on model interpretation of visible UI.

A failed action, observation error, or expired deadline prevents that check's
test steps from starting. The result is inconclusive and labeled
`Setup blocked`. Progress logs identify steps, skips and their evidence,
condition verification, and failures. Setup actions appear in the session
replay when recording is enabled.

Checks share one fresh browser session per run, so saved app state can carry
between checks. When testing the welcome modal itself, temporarily remove or
adjust the recipe so setup does not dismiss the UI under test.

## Validation

The file must be UTF-8 and at most 16000 bytes. It accepts up to 12 steps with
1 to 12 actions each. Unknown fields, duplicate keys or step IDs, unsupported
versions, blank conditions, and missing required fields are rejected before
browser execution. YAML aliases and multiple documents are not supported.

A missing setup file preserves the normal flow. An empty, invalid, unreadable,
or oversized file stops the run.
