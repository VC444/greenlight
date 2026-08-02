import "./quiet.js";
import express from "express";
import { config } from "./config.js";
import { webhookMiddleware } from "./receiver.js";
import { startWorker } from "./worker.js";

const server = express();

// Mounted before any body parser: the middleware verifies the signature
// against the raw request body.
server.use(webhookMiddleware);

server.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

server.listen(config.port, () => {
  console.log(`receiver listening on :${config.port} (webhooks at ${config.webhookPath})`);
});

void startWorker();
