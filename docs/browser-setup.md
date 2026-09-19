# Browser setup

The local skill can apply a personal setup workflow before each check, such as
dismissing a welcome dialog or selecting a workspace. The GitHub Action does
not load or apply this workflow.

## Create and review setup

Run `/greenlight init` in Claude Code, or `$greenlight init` in Codex.
Greenlight asks you to describe the setup steps in order and how to tell the
app is ready. It asks for any missing labels, conditions, or deadlines, then
saves your answers as `~/.greenlight/setup.yaml`. No repository URL is needed.
Initialization does not inspect source code or infer setup steps.

Review the saved recipe before running checks; it has not been
browser-verified. Credentials, MFA, and external sign-in requirements need
manual preparation. Running `init` again displays your existing setup
without overwriting edits. You can also write the file yourself using the
schema below.

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
| `steps[].wait_for` | Visible prerequisite for executing the actions. |
| `steps[].timeout_ms` | Deadline applied separately to the prerequisite and postcondition. |
| `steps[].actions` | Nonempty list of individual UI actions executed in order. |
| `steps[].verify` | Visible postcondition required after all actions. |
| `ready.condition` | Final observable condition required before testing begins. |
| `ready.timeout_ms` | Deadline for the final readiness check. |

Choose conditions and deadlines appropriate for your app. Express waits in conditions and
make checkbox actions idempotent, such as ensuring a checkbox is selected.

Deadlines must be integers from 1 to 300000 milliseconds. Each deadline
includes model observation time. UI actions use the browser driver's action
timeout.

## Execution and failures

Every configured step runs in order. For each step, Greenlight waits for
`wait_for`, executes each action in order, and waits for `verify`. Unsatisfied
or uncertain conditions are retried until their deadline. After every step
has completed, Greenlight evaluates `ready`.
Natural-language conditions depend on model interpretation of visible UI.

A failed action, observation error, or expired deadline prevents that check's
test steps from starting. The result is inconclusive and labeled
`Setup blocked`. Progress logs identify steps,
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

Existing recipes containing `skip_if` are rejected as invalid. Remove that
field before running checks; every remaining step is required.

## PR-specific starting states

Local runs identify prerequisites while planning, using the PR description,
linked issue, common setup, and any notes supplied for that run. When a check
needs missing data or state, Greenlight asks targeted questions in chat before
opening the browser. Simple checks proceed without questions.

For example: "Which failed import should I use to check retry?" Supply an
existing example and where to find it, or instructions for creating it through
ordinary UI actions. You can also supply notes upfront with
`--context-file /tmp/greenlight-context.txt`, or describe them when invoking the
skill. The agent passes chat answers through a temporary context file. Notes
are sent to the configured model backend, are limited to 16000 UTF-8 bytes,
and apply only to the current run. Keep credentials out of them.

Greenlight prepares and verifies each check's starting state after common
setup, before exercising the changed behavior. Readiness observation has a
60-second deadline; preparation actions use the browser action timeout.
Preparation appears in the replay. A missing or unverified prerequisite is
reported as inconclusive with `Prerequisite blocked`.

If you cannot supply a prerequisite, say so or ask to skip the affected check.
It remains inconclusive in the report while other checks can run. File uploads,
backend seeding, and account configuration require manual preparation in this
version. Provide the resulting record's visible location when it is ready.
Each reply triggers fresh planning against the current PR, so a changed PR
can lead to new questions. This conversation is supported by the local skill;
the GitHub Action does not ask prerequisite questions.
