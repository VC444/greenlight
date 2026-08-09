// Rewrites the `uses:` pin in the README to the version in package.json.
// Runs from the `version` lifecycle script — after the bump, before the release
// commit — so the pin ships in the same commit and tag as the bump itself.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const pin = /VC444\/greenlight@v\d+\.\d+\.\d+/g;

const readme = readFileSync("README.md", "utf8");
const found = readme.match(pin) ?? [];

// A release whose README still points at the previous tag sends every new user
// to the old version, so fail the release rather than tag a stale pin.
if (found.length === 0) {
  console.error(
    "No `VC444/greenlight@vX.Y.Z` pin found in README.md — has the usage example moved?",
  );
  process.exit(1);
}

writeFileSync("README.md", readme.replace(pin, `VC444/greenlight@v${version}`));
console.log(`README pin -> v${version} (${found.length} occurrence(s))`);
