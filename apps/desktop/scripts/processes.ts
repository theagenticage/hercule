/**
 * Helpers for the scripts that run Electron as a child process: `./dev.ts`,
 * `./compare-bureau.ts` and `./packaged-app.ts`.
 *
 * The perf script runs on plain Node and reaches this module through
 * `./packaged-app.ts`, so the module uses only TypeScript that Node can strip.
 * It imports nothing heavy, so `pnpm dev` does not load Playwright.
 */
import { createServer, type AddressInfo } from "node:net";
import { constants } from "node:os";

/** Returns a loopback port that nothing is listening on right now. Fails when no port can be opened. */
export const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Returns the exit code a shell reports for a process killed by `signal`: 128 plus the signal's number. */
export const exitCodeForSignal = (signal: NodeJS.Signals): number =>
  128 + constants.signals[signal];

/**
 * Builds the environment the app is started with: this process's environment
 * without `ELECTRON_RUN_AS_NODE` and without any `HERCULE_` variable.
 *
 * - `ELECTRON_RUN_AS_NODE` would make an Electron binary run as plain Node.
 *   The packaged app ignores it (its `RunAsNode` fuse is off), but a shell
 *   that exports it must not decide how the app runs.
 * - A `HERCULE_` variable in the developer's shell must not change the app's
 *   behaviour either.
 */
export function buildAppEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "ELECTRON_RUN_AS_NODE" &&
        !entry[0].startsWith("HERCULE_"),
    ),
  );
}
