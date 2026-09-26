import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import type { Page } from "playwright-core";
import { tsImport } from "tsx/esm/api";
import { SetupBlockedError } from "./setup.js";

export interface NativeSetupContext {
  page: Page;
  previewUrl: string;
  signal: AbortSignal;
}
export type NativeSetupFunction = (context: NativeSetupContext) => Promise<void>;
export interface NativeSetup {
  kind: "native";
  timedOut: boolean;
  run(context: Omit<NativeSetupContext, "signal">, timeoutMs: number): Promise<void>;
  dispose(): Promise<void>;
}

// Keep the module beside the runtime so package imports resolve against the
// Action's pinned dependencies, never against the PR's checkout.
export function createNativeSetup(source: string): NativeSetup {
  let directory: string | undefined;
  let loading: Promise<NativeSetupFunction> | undefined;
  let disposed = false;
  const load = async (): Promise<NativeSetupFunction> => {
    directory = await mkdtemp(path.join(fileURLToPath(new URL("./", import.meta.url)), ".native-setup-"));
    if (disposed) {
      await rm(directory, { recursive: true, force: true });
      throw new Error("Setup was cancelled before loading.");
    }
    const filename = path.join(directory, "setup.mts");
    await writeFile(filename, source, { encoding: "utf8", mode: 0o600 });
    const module = await tsImport(pathToFileURL(filename).href, { parentURL: import.meta.url, tsconfig: false });
    if (typeof module.default !== "function") throw new Error(".greenlight/setup.ts must default-export an async setup function.");
    return module.default as NativeSetupFunction;
  };
  const setup: NativeSetup = {
    kind: "native", timedOut: false,
    async run(context, timeoutMs) {
      if (disposed || setup.timedOut) throw new SetupBlockedError("The native setup session has ended.");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const hook = await (loading ??= load());
            controller.signal.throwIfAborted();
            await hook({ page: context.page, previewUrl: context.previewUrl, signal: controller.signal });
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              setup.timedOut = true;
              controller.abort();
              reject(new SetupBlockedError(`Native setup exceeded ${timeoutMs} ms. The browser session will stop.`));
            }, timeoutMs);
          }),
        ]);
      } catch (error) {
        if (error instanceof SetupBlockedError) throw error;
        throw new SetupBlockedError(error instanceof Error ? error.message : "Native setup failed.");
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async dispose() {
      disposed = true;
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
  return setup;
}
