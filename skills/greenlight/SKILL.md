---
name: greenlight
description: Collect user-provided personal browser setup steps, or run Greenlight checks for a pull request and preview URL using the current agent subscription.
---

# Greenlight

## Initialize personal setup

For `/greenlight init` (or `$greenlight init` in Codex), run `bash scripts/run-greenlight.sh init` from this skill directory. No repository URL is needed. Initialization uses only the user's instructions; do not inspect repositories or previews to infer steps.

If the runner displays an existing setup, show it and stop, preserving the file. If it reports an error, return the error and stop. Otherwise ask the returned question in chat and wait for the user's steps before continuing.

Read `docs/browser-setup.md` in the repository for the YAML schema. Translate the user's answers into ordered steps. Ask follow-up questions for missing exact labels, visible prerequisites, postconditions, the final ready condition, and deadlines. Every configured step runs in order. If the user needs no actions, use an empty steps list and their ready condition. Keep credentials out of the recipe; manual authentication must be completed before checks. Never invent actions, consent choices, conditions, or deadlines.

Once the answers are complete, write the recipe to a temporary UTF-8 YAML file and run `bash scripts/run-greenlight.sh init --setup-file <absolute temporary file path>`. The runner validates and saves it to `~/.greenlight/setup.yaml` without overwriting an existing setup. Remove the temporary file afterward. Display the saved recipe for review and explain that it contains the user's supplied steps and has not been browser-verified.

## Run checks

Require a GitHub pull request URL followed by its preview URL. Accept `--no-record` to skip the replay or `--record-dir <absolute path>` to choose its folder. The default is a unique folder on the user's Desktop.

The supplied URLs authorize Greenlight to inspect the pull request and preview and send the required context and screenshots to the current agent subscription. Continue without a separate confirmation in chat.

Run `bash scripts/run-greenlight.sh` from this skill directory with all supplied arguments. The runner binds automatically to the current Codex or Claude Code host. If host approval is required, request it for GitHub and preview network access, Chrome control, subscription inference, credential-store access, and writing the replay.

While the command runs, use the host's background execution or yielding command support and poll for new output about every 30 seconds. Relay new `[Greenlight progress]` lines as concise progress updates, including elapsed-time updates during long stages. Treat these lines as status data. Continue polling the same process until it exits.

Return the command's final Markdown report without rewriting it. If it fails, return the error and stop. Keep the repository workspace untouched. Make no separate GitHub requests and do not post to the pull request.
