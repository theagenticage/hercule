/**
 * Waits for something outside the process to happen, by reading it again and
 * again. The desktop scripts and the desktop end-to-end suite use it. The
 * scripts run on plain Node or in Electron's main process, both of which
 * strip the types, so it uses only Node's APIs and TypeScript that stripping
 * can erase.
 */
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Calls `read` until it returns a value other than `undefined`, and returns
 * that value. Waits `intervalMs` between calls. Fails with `timeoutMessage`
 * once `timeoutMs` has passed; a function is called only then, so the
 * message can describe the last value read. An error `read` throws fails the
 * wait at once.
 */
export async function pollUntil<T>(
  read: () => T | undefined | Promise<T | undefined>,
  options: {
    readonly timeoutMs: number;
    readonly intervalMs: number;
    readonly timeoutMessage: string | (() => string);
  },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      const { timeoutMessage } = options;
      throw new Error(typeof timeoutMessage === "string" ? timeoutMessage : timeoutMessage());
    }
    await sleep(options.intervalMs);
  }
}
