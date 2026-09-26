# Debugging an inconclusive run

Recorded runs save `diagnostics.json` beside `replay.html`. The local results
report links to both files. Diagnostics are saved before checks begin and after
each check finishes, so a later failure does not discard earlier evidence.
No diagnostic file is written when recording is disabled with `--no-record`.

Start with the failed check in `items`. Its `diagnostics` list contains each
attempted action or condition, its instruction, duration, outcome, and reason.
`scope` distinguishes personal setup, starting-state preparation, and the check
itself. Check actions have a one-based `step` number matching `plan.items[].steps`.
An action failure preserves Stagehand's message or the thrown exception and stack.
The plan also contains the expected outcome and steps that were never reached.

Compare the failed instruction with the replay. For example, if the replay
shows a discount applied but the next instruction asks the action executor to
verify prices, the plan may need a separate observation step. A missing target,
a timeout, or a detached element requires a different investigation. An
inconclusive result alone does not establish which case occurred.

The JSON includes plan content, execution evidence, and browser console errors.
Common credential patterns and secret environment values are redacted, but this
is not a guarantee that all application data is anonymous. Treat the file like
the replay and review it before sharing. It is created with owner-only file
permissions and is not attached to pull request comments.

Artifact write failures produce a progress warning and do not change the check
verdict. Existing `GREENLIGHT_DEBUG=1` logging is still available for live timing
investigations; it is not required to produce the diagnostic file.

## Stagehand API trace

Each check's `stagehandCalls` array records every Greenlight call to Stagehand,
in order, without combining repeated calls:

- `method`: the actual API method, currently `act` or `extract`.
- `instruction`: the exact prompt supplied to that call.
- `schema`: the named output schema for extraction calls.
- `startedAt` and `durationMs`: when the call started and how long it took.
- `status`: `returned` or `threw`. A returned response can still contain
  `success: false`.
- `result`: the full response. For `act`, this includes Stagehand's reported
  actions with their selectors, methods, arguments, descriptions, and cache
  status when provided.
- `error`: the message and stack if the API threw instead of returning.

Setup checks and final verdicts use `extract`; UI actions use `act`. Greenlight
currently makes no direct `observe` or `agent` calls. Navigation uses Playwright
and is not a Stagehand call. This trace captures the API boundary and returned
results, not internal model reasoning or a low-level browser protocol trace.
If Stagehand throws without returning actions, their details are unavailable;
if it returns an unsuccessful result, its action list is preserved but does not
prove every listed action completed. Compare it with the replay.

The same artifact redaction applies to these prompts, results, and errors.
