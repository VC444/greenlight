# Local runner (paused)

Local Claude Code and Codex execution is preserved, but new development focuses on the GitHub Action. This page documents the existing local workflow.

Requires:

- Node 22.20 or newer
- Chrome or Chromium
- GitHub CLI
- Codex or Claude Code

### Install

```bash
npx skills add owner/greenlight -g
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

### Preserved personal setup

The paused local check runner still reads `~/.greenlight/setup.yaml`. Existing
personal recipes remain supported. The `init` command now creates native
`.greenlight/setup.ts` in the app's repository for the GitHub Action; it does
not modify personal YAML or make the paused local check runner execute the
repository script. Use `greenlight setup-check <preview-url>` to test that
script. See [Browser setup](browser-setup.md) for onboarding and the contract.

### Checks that need specific data

For changes deep in a flow, Greenlight uses reproduction instructions from the
PR and asks for missing prerequisites before opening the browser. You can
identify a suitable record, describe how to prepare one, or provide run notes
with `--context-file /tmp/greenlight-context.txt`. Simple checks need no extra
input. Greenlight verifies the starting state before testing; unavailable
prerequisites leave the affected check inconclusive. This is available in the
local skill. See [PR-specific starting states](browser-setup.md#pr-specific-starting-states).
