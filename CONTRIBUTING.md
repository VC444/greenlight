# Contributing to Greenlight

Greenlight has no unit test suite. It is an agent that drives a real browser
against a real deployed preview and asks a model what it sees, so the only
verification that means anything is a full run against a live pull request.
This document is how you get one running locally in about ten minutes.

One thing to absorb before you touch anything user-facing: the codebase uses a
fixed vocabulary, and the code, the comments, the PR output, and the README all
hold to it.

| Term | Means |
| --- | --- |
| **Test Plan** | The set of journeys Greenlight infers a PR should be checked against. Not a test suite or a spec. |
| **Plan Item** | One journey — an Intent, the route it starts from, the steps, and the Expected outcome. |
| **Intent** | What the item exercises, phrased as the user-visible purpose of the change rather than the code implementing it. |
| **Expected** | The observable outcome that decides the item's Verdict. Not an assertion or acceptance criteria. |
| **Judge** | Decides one item's Verdict by comparing its Expected against what is observable on the page. What it cannot observe, it declines to rule on. |
| **Verdict** | Pass, Fail, or Inconclusive. There is no fourth state and no partial credit. |
| **Preview** | The per-PR deployed build Greenlight tests against. Greenlight never runs the app itself. |
| **Correction** | A human's change to a posted Test Plan. Corrections outrank anything Greenlight inferred and are never overwritten. |

## Prerequisites

- **Node 22** — what the Action's runner uses (`action.yml`).
- **pnpm** (`corepack enable`) — the lockfile is pnpm's.
- **A local Chrome.** Stagehand's local mode finds one via `CHROME_PATH`, then
  `which google-chrome|chromium`. It never looks in Playwright's cache, so if
  you only have Playwright's browser, export `CHROME_PATH` yourself.
- **A test repo on Vercel** with an open PR whose preview has already built.
- **An LLM API key** for any supported provider — Anthropic, OpenAI, Google, or
  an OpenAI-compatible host (Fireworks, Together, OpenRouter). Nothing in the
  local loop assumes a particular one.

```bash
pnpm install
cp .env.example .env
```

## What to export

Two groups: secrets that live in `.env`, and the per-run coordinates you export
in your shell.

### In `.env` (loaded by `dotenv/config`, never committed)

| Variable | Needed | Notes |
| --- | --- | --- |
| `GREENLIGHT_LLM_API_KEY` | yes | The key, whichever provider you run. `GREENLIGHT_MODEL` picks the provider; this is its key. There is deliberately no `ANTHROPIC_API_KEY`-style alternative — a second source could only ever disagree with the selected provider, and the losing side would be a credential sent to the wrong host. Without a key `canExecute()` is false and the browser never opens. |
| `GREENLIGHT_MODEL` | no | `provider/model` — `anthropic/claude-opus-5`, `openai/gpt-5`, `google/gemini-3-flash`, `fireworks/…`, `together/…`, `openrouter/…`. Unset uses the default. `GREENLIGHT_EXECUTOR_MODEL` and `GREENLIGHT_VISUAL_JUDGE_MODEL` override the browser-driving and screenshot Judges independently. |
| `VERCEL_AUTOMATION_BYPASS_SECRET` | if previews are protected | The default on Vercel Pro/Team. Vercel → Settings → Deployment Protection → Protection Bypass for Automation. |

Anything else `.env.example` lists is optional — leave it blank and the defaults
hold.

### In your shell

```bash
export GITHUB_TOKEN=github_pat_...   # fine-grained PAT, scopes below
export TEST_REPO=owner/repo          # the repo with the open PR
export TEST_PR=12                    # an existing PR whose preview is BUILT
```

The PAT needs, on the test repo: **Contents** `read`, **Pull requests**
`read+write`, **Deployments** `read`, **Issues** `read`. Don't worry about
Checks — see the 403 note below.

Use an **already-open PR with a finished preview**. `waitForPreview` polls for
up to five minutes; an existing preview returns ready on the first poll. Reruns
are safe — both the plan comment and the results comment upsert in place.

## Running a full pipeline locally

`src/actionMain.ts` is verbatim what the Action runs (`action.yml:116`). Same
entry point, same `processJob`, same recorder — only the environment differs.

### 1. Build the event fixture

Don't hand-write it. Transcribing the head SHA wrong is precisely the bug this
guards against, and a typo would be indistinguishable from it.

```bash
curl -s -H "Authorization: Bearer $GITHUB_TOKEN" \
     -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/$TEST_REPO/pulls/$TEST_PR" \
| jq '{action: "synchronize", pull_request: {number: .number, head: {sha: .head.sha}}}' \
> /tmp/greenlight-event.json

cat /tmp/greenlight-event.json
```

Those three fields are the whole contract: `actionMain.ts` reads `action`,
`pull_request.number` and `pull_request.head.sha` and nothing else
(`src/actionMain.ts:37-68`). `action` must be `opened` or `synchronize`;
anything else exits early by design.

The SHA has to be `.head.sha`, the branch head — **not** `GITHUB_SHA`, which on
`pull_request` is a synthesized merge commit that no preview was ever deployed
for.

### 2. Run it

```bash
GITHUB_EVENT_PATH=/tmp/greenlight-event.json \
GITHUB_REPOSITORY=$TEST_REPO \
GREENLIGHT_LOCAL_BROWSER=1 \
GREENLIGHT_REPLAY_DIR=./greenlight-replay \
GREENLIGHT_DEBUG=1 \
npx tsx src/actionMain.ts
```

`GITHUB_TOKEN` is already exported, so it doesn't need repeating here.

- `GREENLIGHT_LOCAL_BROWSER=1` runs Chrome on your machine instead of opening a
  Browserbase session — free, and no Browserbase credentials required. Inference
  is identical either way.
- `GREENLIGHT_HEADLESS` stays unset, so Chrome is headed and you can watch the
  run. The Action sets it because a runner has no display.
- `GREENLIGHT_DEBUG=1` adds phase-by-phase timing, which is how you localize a
  stall (`goto` vs `act` vs the Judge). Far too noisy for CI.
- Add `GREENLIGHT_MOCK_PLAN=1` to skip the plan model and use the fixture in
  `src/mockPlan.ts` — deterministic, and it spends nothing on plan generation.
  Use it whenever the thing under test is downstream of the plan.

Command-line vars beat `.env` (dotenv doesn't override), so anything you set
here wins while your keys still come from the file.

### 3. What a healthy run prints

```
posted plan comment on owner/repo#12            ← or "updated"
preview for owner/repo#12 ready at https://…    ← the head-SHA lookup worked
local browser session (model <provider>/<model>, visual judge <provider>/<model>)
  item "…" @ /: pass — …
wrote session replay to ./greenlight-replay/replay.html (2 item(s), N events)
posted results comment on owner/repo#12
```

| Symptom | Cause |
| --- | --- |
| `Missing required env var …` | A `config` getter that should be lazy is being evaluated at import (`src/config.ts:31`). Nothing may demand a credential this path doesn't use. |
| `no Vercel preview for …` | Wrong head SHA, or that PR genuinely has no preview. |
| `preview poll … forbidden` | PAT is missing Deployments `read`. |
| Browser never opens | `canExecute()` is false — the LLM key isn't reaching the process. |
| No `wrote session replay` line | Real bug: rrweb didn't survive the run. |
| `check run … forbidden` (403) | **Expected locally. Ignore.** |

On that 403: check runs are a GitHub App endpoint, and a PAT is refused whatever
its permissions say. `postCheckRun` catches it, logs a fix-it, and the results
comment still posts (`src/results.ts:118`). On a runner, `github.token` *is* an
App token, so it cannot recur there.

### 4. Watch the replay

```bash
open ./greenlight-replay/replay.html
```

One self-contained file: a dark page, a button per Plan Item, a scrubbable
player. A blank stage or a console error means the rrweb-player bundle
resolution in `src/recorder.ts:26` broke. The replay is the artifact that makes
a Verdict trustworthy, so check it whenever you touch execution.

## Exercising the visual Judge

The screenshot escalation only fires when the DOM-only Judge answers
`cannot_tell`, so an ordinary run usually never reaches it. Two ways to confirm
it's wired:

- The session line prints `visual judge <provider>/<model>` — or
  `no visual judge` when no vision model resolved.
- An escalated item logs `pass (from screenshot) — …`.

To force the path, run with `GREENLIGHT_MOCK_PLAN=1` and give a `MOCK_PLAN`
item an `expected` that is only true in pixels — *"the Apply button is visibly
greyed out"*, *"the success message is green"*. Anything carried by aria or text
will be settled by the DOM Judge and never escalate.

Set `GREENLIGHT_VISUAL_JUDGE_MODEL=off` to check the fallback behaviour: those
items should come back Inconclusive, never Fail.

If you're on `together` or `openrouter` you'll see `no visual judge` and a line
explaining why — those providers have no default vision model, and the
escalation deliberately won't reach for another vendor's, since one key setting
feeds every provider and a cross-provider default would ship your key to a host
you never chose. Name any vision model in `GREENLIGHT_VISUAL_JUDGE_MODEL` to
test the path.

## House rules

These are product invariants, not style preferences. A change that breaks one
is wrong even if it works.

- **The check is never red.** `conclusion()` returns only `success` or
  `neutral` (`src/results.ts:43`). A Fail is a finding, not a merge blocker,
  because a model that guesses wrong must never block someone's merge.
- **Silence beats noise.** When something can't be established — no preview, no
  browser, a broken run — Greenlight logs and posts nothing. Reporting must
  never crash a job, and a broken run is not a Verdict.
- **Inconclusive is a real answer.** Don't push the Judge toward a guess to
  make the output look decisive. A false Fail costs far more trust than a ❔.
- **Use the vocabulary above** in code, comments, and anything a user reads.
  Consistent naming is why the PR output reads as one voice.
- **Comments explain why, not what.** The existing ones document the constraint
  or the failure that forced the shape of the code — match that. Don't narrate
  the syntax.

## Before you open a PR

```bash
pnpm typecheck
```

Then run the pipeline locally at least once against a live PR. A green
typecheck says nothing about whether an agent still completes a journey.

If your change touches `action.yml` — inputs, the `env:` block, the browser
resolution step — a local run cannot cover it. That layer only exists on a
runner: Actions sets an unprovided input to the empty string rather than
omitting it, so a `??` fallback that works locally silently yields `""` there.
Test those against a real workflow run.
