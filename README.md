# Greenlight

Greenlight is a GitHub Action that turns your teammate's PR into a test plan and runs it in a real browser. It reports what worked and what didn't, with a recording of the entire session.

It is built for **Next.js apps deployed on Vercel**. Other setups are out of
scope for now.

**The check is never red.** Greenlight's check run concludes `success` or
`neutral`, nothing else. An AI judge that guesses wrong must never block a
merge. When a run can't establish something, it says Inconclusive (❔) instead
of failing you, and when it has nothing useful to say, it says nothing.

<img width="2556" height="1349" alt="Greenlight PR - Start" src="https://github.com/user-attachments/assets/e286afde-3acb-40d9-9fc2-9aa2bc803e2f" />

<img width="2557" height="1345" alt="Greenlight PR Comment" src="https://github.com/user-attachments/assets/337e5e0a-4b46-42b2-9efc-8014b0d0ba82" />

## Steps to run

**1. Go to your repo** that has Vercel preview deployments enabled.

**2. Add the secrets.** Repo → Settings → Secrets and variables → Actions:

- `GREENLIGHT_API_KEY`: required. This will be your LLM provider key (see
  [Choosing a model](#choosing-a-model)).
- `VERCEL_AUTOMATION_BYPASS_SECRET`: only if your preview deployments are
  protected (the default on Vercel Pro/Team). Vercel → Settings → Deployment
  Protection → Protection Bypass for Automation.

**3. Copy this workflow** to `.github/workflows/greenlight.yml` and put the `model` param of your choice:

```yaml
name: Greenlight

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read # read the diff and changed files
  pull-requests: write # post the plan and results comments
  checks: write # post the check run
  deployments: read # find the PR's preview deployment
  issues: read # read a linked issue for context

# A new push supersedes the run in flight; no point testing a preview that is
# already stale.
concurrency:
  group: greenlight-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  greenlight:
    runs-on: ubuntu-latest
    # Forks do not get secrets, so the run could never reach the model.
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: VC444/greenlight@v0.2.0
        with:
          llm-api-key: ${{ secrets.GREENLIGHT_API_KEY }}
          vercel-bypass-secret: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
          # required; see "Choosing a model"
          model: <provider>/<model-id>
```

**4. Open a pull request.** That's the whole setup.

## What a run looks like

1. Greenlight reads the PR (diff, commit messages, changed files, a linked
   issue if there is one) and posts a **plan comment**: what it thinks the
   change is for, and the browser checks it intends to run.
2. It waits for the Vercel preview to build, then opens the preview in a
   headless browser on the runner and works through each item: natural-language
   steps, executed for real by clicking, typing, and reading the page.
3. It posts a **results comment** and a check run: ✅ Pass, ❌ Fail, or
   ❔ Inconclusive per item, each with the judge's reasoning.
4. The full browser session is recorded and uploaded as a workflow artifact
   (`greenlight-replay-<PR>-<attempt>`), a single self-contained HTML file.
   Download it, open it, scrub through exactly what the browser saw.

If the PR has nothing browser-testable, or no preview appears, Greenlight stays
silent rather than posting noise.

## Steering the plan

The plan comment is Greenlight's contract with you before it runs, and it is
editable. By default nothing is required of you: the run box is checked, so as
soon as the preview is ready Greenlight goes.

- **Uncheck "Run these checks"** to pause. Greenlight holds, says so on the PR,
  and waits for you to check it again — then runs the plan _as the comment
  stands_, including anything you changed while it waited.
- **Uncheck an item** to skip just that one.
- **Edit the wording** of a step, a route, or an expectation and Greenlight
  runs what you wrote. Nothing is required to be in our phrasing; write the
  steps the way you'd tell a person.
- **Delete the comment** to call the run off entirely.

Every edit applies to the commit the plan was written for. Push again and
Greenlight writes a fresh plan for the new code, with the box checked again,
because a plan for the previous commit isn't an answer about this one.

If you never check the box back on, the run gives up quietly after 30 minutes
(`pause-timeout-minutes`) rather than holding a runner open. Checking it after
that won't reach the finished run; push again to start over.

## Inputs

| Input                   | Required | Description                                                                                                                                              |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm-api-key`           | yes      | API key for the provider named in `model`. Drives both plan generation and the browser run.                                                              |
| `model`                 | yes      | `provider/model` to run. No default — the run fails without it. See [Choosing a model](#choosing-a-model).                                               |
| `vercel-bypass-secret`  | no       | Vercel protection-bypass secret, for protected previews.                                                                                                 |
| `executor-model`        | no       | Override just the model that drives and judges browser steps. Defaults to `model`.                                                                       |
| `visual-judge-model`    | no       | Model that re-judges from a screenshot when the DOM can't settle an expectation. See [Judging what the DOM can't show](#judging-what-the-dom-cant-show). |
| `pause-timeout-minutes` | no       | How long a run waits when you uncheck the run box, before giving up. Default 30. Only spends runner minutes when someone actually pauses.                |

## Choosing a model

`model` is required and takes a `provider/model` string. One key drives both the
test plan and the browser run, so the key you pass must belong to the provider
you name.

| Provider     | Where the ids are listed                                                                |
| ------------ | --------------------------------------------------------------------------------------- |
| `anthropic`  | [platform.claude.com](https://platform.claude.com/docs/en/about-claude/models/overview) |
| `openai`     | [developers.openai.com](https://developers.openai.com/api/docs/models)                  |
| `google`     | [ai.google.dev](https://ai.google.dev/gemini-api/docs/models)                           |
| `fireworks`  | [fireworks.ai/models](https://fireworks.ai/models)                                      |
| `together`   | [docs.together.ai](https://docs.together.ai/docs/serverless-models)                     |
| `openrouter` | [openrouter.ai/models](https://openrouter.ai/models)                                    |

The prefix is required. An id without one is rejected rather than guessed at:
your key is only good for one provider, and Greenlight will not pick which host
receives it.

Examples, as the line reads in the workflow's `with:` block:

- `model: openai/gpt-5.6-sol`
- `model: anthropic/claude-opus-5`
- `model: fireworks/accounts/fireworks/models/kimi-k3`

Those are ids that existed when this was written, not recommendations.

**One constraint, on the OpenAI-compatible hosts only.** For the browser run,
`fireworks`, `together`, and `openrouter` are reliable with the `kimi`,
`deepseek`, and `glm` families; other models there can emit malformed steps that
show up as inconclusive items. Greenlight warns at startup when your executor
model is in that position. The native providers (`anthropic`, `openai`,
`google`) have no such limit.

## Judging what the DOM can't show

Each item's `expected` is judged against the page's DOM and accessibility tree,
which is blind to anything carried by pixels alone. Rather than guess, that
judge can answer "can't tell". When it does, Greenlight screenshots the viewport
and puts the same question to a vision model, and that answer decides the item.
If the screenshot doesn't settle it either, the item stays ❔ Inconclusive, never
a failure. Nothing else triggers the escalation, so a run whose expectations are
all readable costs nothing extra.

The judge defaults to a model on the provider you already run and never another
vendor. On `together` and `openrouter` it can pass an item but not fail one,
since those hosts serve arbitrary model ids that may not accept an image; name a
vision model in `visual-judge-model` to lift that, or `off` to skip it.

## Limits worth knowing

- **No native browser dialogs.** `alert()`/`confirm()` are suppressed to keep
  the session alive; expectations about them can't be checked.
- **With the visual judge off (`visual-judge-model: "off"`), visual expectations
  can't be judged.** Nor can they be _failed_ on `together` and `openrouter`
  unless you name the judge yourself.
- **Anything it can't establish comes back ❔ Inconclusive**: expected, honest,
  and never a red check. If a run breaks midway, that item is Inconclusive too,
  not a failure.

## License

[MIT](LICENSE).
