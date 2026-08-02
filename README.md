# Greenlight

Greenlight tests your pull requests without asking anyone to write tests. On
every PR it reads the diff, works out what the change is *for*, drives the
Vercel preview deployment in a real browser to check it, and reports what it
found: a plan comment, a results comment, a check run, and a downloadable
session replay.

It is built for **Next.js apps deployed on Vercel**. Other setups are out of
scope for now.

**The check is never red.** Greenlight's check run concludes `success` or
`neutral`, nothing else. An AI judge that guesses wrong must never block a
merge. When a run can't establish something, it says Inconclusive (❔) instead
of failing you, and when it has nothing useful to say, it says nothing.

<!-- screenshot: plan comment + results comment (add after first public run) -->

## Add it to a repo

You need a repo that gets Vercel preview deployments on PRs (the standard
Vercel GitHub integration), and a [Fireworks API
key](https://app.fireworks.ai/settings/users/api-keys). Greenlight runs
entirely inside your GitHub Actions runner with your keys. There is no server
to host, no account to create, and nothing phones home.

**1. Add the secret.** Repo → Settings → Secrets and variables → Actions:

- `FIREWORKS_API_KEY`: required.
- `VERCEL_AUTOMATION_BYPASS_SECRET`: only if your preview deployments are
  protected (the default on Vercel Pro/Team). Vercel → Settings → Deployment
  Protection → Protection Bypass for Automation.

**2. Copy the workflow** to `.github/workflows/greenlight.yml`:

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
      - uses: VC444/greenlight@v0.1.1
        with:
          llm-api-key: ${{ secrets.FIREWORKS_API_KEY }}
          vercel-bypass-secret: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

**3. Open a pull request.** That's the whole setup.

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

The plan comment is Greenlight's contract with you before it runs:

- **React 👎 to the plan comment** and the next push regenerates it from
  scratch.
- **Delete the comment** and the next push starts fresh.
- Your edits to the comment are never overwritten by later pushes.

## Inputs

| Input | Required | Description |
| --- | --- | --- |
| `llm-api-key` | yes | Fireworks API key. Drives both plan generation and the browser run. |
| `vercel-bypass-secret` | no | Vercel protection-bypass secret, for protected previews. |
| `model` | no | Override the model that writes the test plan. |
| `executor-model` | no | Override the model that drives and judges browser steps. Must stay in the kimi/deepseek/glm families; Stagehand only grammar-enforces its schemas for those. |
| `inline-images` | no | Embed images in the replay (default `true`) so it renders after the preview is torn down. Set `false` for smaller artifacts. |
| `replay-retention-days` | no | How long to keep the replay artifact (default `14`). |

With the default models a typical PR costs a few cents in Fireworks credits.

## What Greenlight can't judge

The judge reads the page's DOM and accessibility tree. It does not see pixels.
That means some honest limits:

- **No visual assertions.** "The button is misaligned" or "the color is wrong"
  is invisible to it.
- **No native browser dialogs.** `alert()`/`confirm()` are suppressed to keep
  the session alive; expectations about them can't be checked.
- **Anything it can't establish from the page comes back ❔ Inconclusive**:
  expected, honest, and never a red check. If a run breaks midway, that item is
  Inconclusive too, not a failure.

One more note: text typed during a run comes from the plan steps and is
recorded readably in the replay artifact. Don't put secrets in plan steps.

## License

[MIT](LICENSE).
