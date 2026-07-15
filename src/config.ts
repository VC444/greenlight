import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var ${name} — copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

function loadPrivateKey(path: string): string {
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch {
    console.error(`Could not read private key at ${path} (PRIVATE_KEY_PATH).`);
    process.exit(1);
  }
  // GitHub downloads keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), but Octokit's
  // auth uses WebCrypto, which only accepts PKCS#8 — convert if needed.
  if (pem.includes("BEGIN RSA PRIVATE KEY")) {
    pem = createPrivateKey(pem).export({ type: "pkcs8", format: "pem" }).toString();
  }
  return pem;
}

export const config = {
  appId: required("APP_ID"),
  webhookSecret: required("WEBHOOK_SECRET"),
  privateKey: loadPrivateKey(required("PRIVATE_KEY_PATH")),
  port: Number(process.env.PORT ?? 3000),
  webhookPath: "/api/webhooks",
};
