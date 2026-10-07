/**
 * Tests `killProcessesHolding` on real processes. A shell opens a file the way
 * a pi agent's bash call does, starts a background process and exits, so the
 * background process is left running with the file open. That is the process
 * an agent's Stop has to end.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { killProcessesHolding } from "./process";

const directory = mkdtempSync(join(tmpdir(), "hercule-process-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** Checks whether the process with `pid` still runs. */
const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("killing the processes that hold a file open", () => {
  it("kills a background process its shell left running with the file open", async () => {
    const file = join(directory, "held.ts");
    writeFileSync(file, "");
    // The background sleep's output goes to /dev/null, so the shell's own
    // output closes when the shell exits and spawnSync returns.
    const shell = Bun.spawnSync(
      ["/bin/sh", "-c", 'exec 9<"$HELD"; sleep 30 >/dev/null 2>&1 & echo $!'],
      { env: { ...process.env, HELD: file } },
    );
    const pid = Number(shell.stdout.toString().trim());
    try {
      expect(isRunning(pid)).toBe(true);

      await Effect.runPromise(killProcessesHolding(file));

      expect(isRunning(pid)).toBe(false);
    } finally {
      if (isRunning(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("does nothing for a file no process holds, or one that does not exist", async () => {
    const file = join(directory, "free.ts");
    writeFileSync(file, "");

    await Effect.runPromise(killProcessesHolding(file));
    await Effect.runPromise(killProcessesHolding(join(directory, "missing.ts")));
  });
});
