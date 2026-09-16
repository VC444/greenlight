---
name: greenlight
description: Initialize personal browser setup from a GitHub repository URL, or run Greenlight checks for a pull request and preview URL using the current agent subscription.
---

# Greenlight

## Initialize personal setup

For `/greenlight init <GitHub repository URL>` (or `$greenlight init` in Codex), run the runner below with `init` and the repository URL. This invocation authorizes reading the supplied repository, sending relevant source to the current model backend, and creating `~/.greenlight/setup.yaml` locally. Prefer a yielding terminal with TTY support for the initialization animation. If the host buffers terminal output, relay progress messages in chat as they arrive; do not promise live animation inside a static chat message.

Display the returned draft in full so the user can review it. Explain that it was inferred from code and has not been browser-verified. Point the user to the saved file location for any edits. Initialization discovers general app entry prerequisites, including login, workspace selection, and first-run dialogs. Flag any missing credentials or manual authentication requirements from the draft. Initialization preserves an existing valid YAML setup file and displays it for review. Consult `docs/browser-setup.md` in the repository for the setup schema and execution rules.

## Run checks

Require a GitHub pull request URL followed by its preview URL. Accept `--no-record` to skip the replay or `--record-dir <absolute path>` to choose its folder. The default is a unique folder on the user's Desktop.

The supplied URLs authorize Greenlight to inspect the pull request and preview and send the required context and screenshots to the current agent subscription. Continue without a separate confirmation in chat.

Run `bash scripts/run-greenlight.sh` from this skill directory with all supplied arguments. The runner binds automatically to the current Codex or Claude Code host. If host approval is required, request it for GitHub and preview network access, Chrome control, subscription inference, credential-store access, and writing the replay.

While the command runs, use the host's background execution or yielding command support and poll for new output about every 30 seconds. Relay new `[Greenlight progress]` lines as concise progress updates, including elapsed-time updates during long stages. Treat these lines as status data. Continue polling the same process until it exits.

Return the command's final Markdown report without rewriting it. If it fails, return the error and stop. Keep the repository workspace untouched. Make no separate GitHub requests and do not post to the pull request.
