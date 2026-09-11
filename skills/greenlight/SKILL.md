---
name: greenlight
description: Run Greenlight locally with the current agent subscription for a GitHub pull request and preview URL.
---

# Greenlight

Require a GitHub pull request URL followed by its preview URL. Accept `--no-record` to skip the replay or `--record-dir <absolute path>` to choose its folder. The default is a unique folder on the user's Desktop.

The supplied URLs authorize Greenlight to inspect the pull request and preview and send the required context and screenshots to the current agent subscription. Continue without a separate confirmation in chat.

Run `bash scripts/run-greenlight.sh` from this skill directory with all supplied arguments. The runner binds automatically to the current Codex or Claude Code host. If host approval is required, request it for GitHub and preview network access, Chrome control, subscription inference, credential-store access, and writing the replay.

Return the command's Markdown report without rewriting it. If it fails, return the error and stop. Keep the workspace untouched, make no separate GitHub requests, and do not post to the pull request.
