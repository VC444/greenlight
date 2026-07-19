# Greenlight

AI PR test bot. A GitHub App that fires on every pull request, infers intent from the change, drives the Vercel preview to test it, and posts pass/fail results.

**Where we are:** on every PR open/push, the worker gathers the PR's context (diff, commits, linked issue, changed files), asks an LLM (Kimi K2.6 on Fireworks, schema-enforced) for a structured test plan, and posts it as a PR comment. The comment is the source of truth for corrections: unchecking a box skips that test, editing the text corrects the plan (human edits are never overwritten), a 👎 reaction requests a fresh plan on the next push, and deleting the comment resets everything. Execution against the Vercel preview is next (Phases 3–5).

## Architecture

One always-on Node process, two internal modules:

- **Receiver** (`src/receiver.ts`): Express route at `POST /api/webhooks`. Verifies the webhook signature (via `@octokit/webhooks`), enqueues a job, acks 200 immediately.
- **Worker** (`src/worker.ts`): async loop draining an in-memory queue (`src/queue.ts`). Authenticates as the App installation and posts the PR comment. Per-job errors are logged, never fatal.

## Setup

### 1. Mint a smee channel

Open <https://smee.io/new> — copy the channel URL. (smee forwards GitHub's webhook deliveries to your laptop, headers intact, so signature verification still works.)

### 2. Register the GitHub App (manual, one-time)

GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**:

- **Name:** `greenlight-<yourname>` (must be globally unique)
- **Homepage URL:** this repo's URL (anything works)
- **Webhook URL:** your smee channel URL
- **Webhook secret:** generate one (`openssl rand -hex 32`) and save it — you'll need it in `.env`
- **Repository permissions** (exactly these, nothing more — never push access):
  | Permission | Level | Why |
  |---|---|---|
  | Contents | Read-only | fetch diff/files (Phase 1) |
  | Pull requests | Read & write | receive PR events + post comments |
  | Checks | Read & write | check runs (Phase 5) |
  | Issues | Read-only | linked issues (Phase 1) |
- **Subscribe to events:** Pull request (only)
- **Where can this app be installed:** Only on this account

After creating: note the **App ID**, then **Generate a private key** (downloads a `.pem` — move it into this directory; it's gitignored).

Finally, from the App page: **Install App** → choose a test repository.

### 3. Configure and run

```sh
cp .env.example .env   # fill in APP_ID, WEBHOOK_SECRET, PRIVATE_KEY_PATH, SMEE_URL
pnpm install
pnpm smee              # terminal 1: forward webhooks to localhost
pnpm dev               # terminal 2: receiver + worker
```

Open a PR on the test repo (or push to an open one). Within seconds the bot should comment: *"👋 Greenlight saw this PR…"*.

## Security posture

- Minimum scopes; never push access.
- Webhook signatures verified on every delivery; unsigned requests are rejected.
- Installation tokens live in memory only; no code or payloads are persisted.
