// Forwards webhook deliveries from the smee.io channel to the local receiver.
// Run via `pnpm smee` (loads SMEE_URL from .env with node --env-file).
import SmeeClient from "smee-client";

const source = process.env.SMEE_URL;
if (!source) {
  console.error("Set SMEE_URL in .env (mint a channel at https://smee.io/new).");
  process.exit(1);
}

const port = process.env.PORT ?? 3000;
const smee = new SmeeClient({
  source,
  target: `http://localhost:${port}/api/webhooks`,
  logger: console,
});

smee.start();
