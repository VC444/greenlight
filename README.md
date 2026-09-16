# Greenlight

Greenlight turns your teammate's pull request into a test plan and runs it in a real browser. It reports what worked and what didn't, with a recording of the entire session.

## Run Greenlight locally as a skill

Requires:

- Node 22.20 or newer
- Chrome or Chromium
- GitHub CLI
- Codex or Claude Code

### Install

```bash
npx skills add VC444/greenlight -g
```

### Codex permissions

Greenlight reads the supplied pull request, opens the supplied preview in
Chrome, sends the required context and screenshots to your current ChatGPT
subscription, and writes the replay locally. Codex may deny the run if that
authorization is not explicit.

To authorize this workflow once for future Greenlight runs, add the following
to `~/.codex/AGENTS.md`:

```markdown
## Greenlight

When I explicitly invoke `$greenlight` with a GitHub pull request URL and a
preview URL, that invocation authorizes Greenlight to:

- inspect only that pull request and preview;
- send the required pull request context and preview screenshots to my current
  ChatGPT subscription for analysis;
- control Chrome and use stored authentication only to access the supplied
  URLs;
- write the replay to the requested directory, or to the Desktop by default.

This authorization applies only to the supplied URLs and the current run. It
does not authorize posting to the pull request, changing repository data,
exposing credential values, or accessing unrelated sites.
```

Restart Codex after changing `~/.codex/AGENTS.md`.

### Run

Start a Codex or Claude Code session, then invoke Greenlight. You just have to pass two args:

1. Github PR Link
2. URL where your web app is running with the PR changes (localhost or live url)

```text
# Codex
$greenlight https://github.com/owner/repo/pull/123 http://localhost:3000

# Claude Code
/greenlight https://github.com/owner/repo/pull/123 http://localhost:3000
```

Local skill mode also accepts GitHub Enterprise Server PR URLs, such as
`https://github.example.com/owner/repo/pull/1259`. Authenticate with
`gh auth login -h github.example.com` on the machine running the skill.
Enterprise Server uses `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` when set,
otherwise Greenlight reads the GitHub CLI token for the supplied hostname.
Public GitHub tokens are not reused for Enterprise Server hosts.

Codex uses your ChatGPT subscription. Claude Code uses your Claude subscription
or your configured LiteLLM gateway. For a gateway, export `ANTHROPIC_BASE_URL`
and `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`) in the environment that
launches Claude Code. Greenlight preserves those settings and `ANTHROPIC_MODEL`
for its Claude child process. Gateway credentials are checked by the model
request; a Claude subscription login is not required. Settings-file-only gateway
configuration is not supported by Greenlight's isolated Claude invocation.
Greenlight saves a replay to your Desktop unless you pass `--no-record`.

### Optional browser setup (local skill only)

If your app needs preparation before testing, describe it with the preview URL:

```text
/greenlight init https://preview.example.com "Tick the acknowledgment checkbox and click Continue."
```

In Codex, use `$greenlight init` with the same preview URL and instructions.
Greenlight inspects the preview, writes a minimal Playwright hook, runs it to
verify the requested outcome, and saves it to `~/.greenlight/setup.ts`. You do
not need to write code. No repository scan or inferred onboarding workflow is
involved. Omit the instructions and the skill asks what needs preparing.

Future local checks run the hook automatically before each check. To change
it, run `init` again with new instructions, such as "Also select the demo
workspace." Failed verification preserves your previous setup. One personal
hook applies across repositories, so replace it when switching apps.

See [Browser setup](docs/browser-setup.md) for prompt examples, verification,
execution rules, and migration from old setup files.

## Want Greenlight on all PRs? Set up the GitHub Action

The GitHub Action is built for **Next.js apps deployed on Vercel**. Other Action
setups are out of scope for now.

Demo: https://www.youtube.com/watch?v=Av5Zy-Phg-0

Book a call: https://cal.com/vignesh-cal/greenlight-demo

<img width="2557" height="1345" alt="Greenlight PR Comment" src="https://github.com/user-attachments/assets/337e5e0a-4b46-42b2-9efc-8014b0d0ba82" />

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
      - uses: VC444/greenlight@v1
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
  and waits for you to check it again. It then runs the plan _as the comment
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
| `model`                 | yes      | `provider/model` to run. There is no default; the run fails without it. See [Choosing a model](#choosing-a-model).                                       |
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
