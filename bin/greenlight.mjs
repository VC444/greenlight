#!/usr/bin/env node
import { register } from "tsx/esm/api";
register();

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "init") {
    const { runGreenlightInit, parseInitOptions } = await import("../src/init.ts");
    console.log(await runGreenlightInit(parseInitOptions(args)));
  } else if (command === "setup-check") {
    const { checkSetup } = await import("../src/setupCheck.ts");
    await checkSetup(args);
  } else {
    await import(new URL("../src/skillMain.ts", import.meta.url).href);
  }
} catch (error) {
  console.error(`Greenlight: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
