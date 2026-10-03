# Greenlight

Greenlight is a GitHub Action that tests your teammate's pull requests in a real browser.
It reads the PR, creates a test plan, runs it against the Vercel preview, and
posts the results on the PR. Each check is marked Pass, Fail, or
Inconclusive, with a browser replay attached to the workflow run.

<img width="1273" height="340" alt="Screenshot 2026-10-03 at 11 30 52 PM" src="https://github.com/user-attachments/assets/a9d93e88-65b1-416e-894e-fd81324db722" />

<img width="942" height="882" alt="Screenshot 2026-10-03 at 11 30 15 PM" src="https://github.com/user-attachments/assets/08ccdabb-99e3-4a30-94a4-e8f5920c8e8a" />


[Watch the demo](https://youtu.be/Av5Zy-Phg-0?si=kWPwq_MZpvcBgMJZ) or
[book a call](https://cal.com/vignesh-cal/greenlight-demo).

## Add the GitHub Action

Add these repository secrets:

- `GREENLIGHT_API_KEY`: your LLM provider's API key.
- `VERCEL_AUTOMATION_BYPASS_SECRET`: needed if the Vercel preview is protected.

Create `.github/workflows/greenlight.yml`:

```yaml
name: Greenlight

on:
  pull_request:
    types: [opened, synchronize]

permissions:
  contents: read
  pull-requests: write
  checks: write
  deployments: read
  issues: read

concurrency:
  group: greenlight-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  greenlight:
    runs-on: ubuntu-latest
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: VC444/greenlight@v1
        with:
          llm-api-key: ${{ secrets.GREENLIGHT_API_KEY }}
          model: <provider>/<model-id>
          vercel-bypass-secret: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

Set `model` to a model supported by the provider whose API key you supplied.
See [Choosing a model](#choosing-a-model) below.

Open a PR or push a new commit. Greenlight posts its plan, waits for the preview,
and runs the checks. You can pause and edit the plan through its PR comment.
Missing prerequisites are reported as Inconclusive.

## Prepare your app with `greenlight init`

If testing requires preparation, such as logging in or dismissing
a dialog, create a setup script once in your app's repository.

Install the Greenlight skill for your coding agent:

```bash
npx skills add VC444/greenlight -g
```

Use Node.js 22.20 or newer. Open a Codex or Claude Code session in your app's
repository, then invoke the skill:

```text
/greenlight init
```

Describe the preparation and how to recognize success. The agent asks for
missing details and writes deterministic Playwright code to `.greenlight/setup.ts` at
the repository root, preserving any existing script. Review it before testing.
Greenlight runs this script before each check. If your app needs no preparation,
you can skip it.

## Verify setup with `greenlight setup-check`

With Chrome available, invoke the skill in the same agent session:

```text
/greenlight setup-check https://preview.example
```

Replace the URL with your app's local preview (eg. http://localhost:3000). The skill runs your local setup script
using Playwright without model calls, reports failures, and saves a browser
replay in `greenlight-replay`.

Review the replay, then commit `.greenlight/setup.ts` to your PR. **PR runs use
the setup script from the PR's exact head commit**, so setup additions and edits
are exercised before merging.

See [Browser setup](docs/browser-setup.md) for script examples and
[action.yml](action.yml) for optional Action inputs.

## Choosing a model

`model` is required and takes a `provider/model` string. Pick any model from [OpenRouter's model catalog](https://openrouter.ai/models).

Examples, as the line reads in the workflow's `with:` block:

- `model: openai/gpt-5.6-sol`
- `model: anthropic/claude-opus-5.5`
- `model: fireworks/accounts/fireworks/models/kimi-k3`

Those are ids that existed when this was written, not recommendations.
