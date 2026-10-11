/**
 * Tests `stopChild` on fake children, and `killProcessesHolding` on real processes. A shell opens a file the way
 * a pi agent's bash call does, starts a background process and exits, so the
 * background process is left running with the file open. That is the process
 * an agent's Stop has to end.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import { killProcessesHolding, stopChild, type StopSignal } from "./process";

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

/** Builds a fake child whose exit the test controls and which records the signals sent to it. */
const buildSlowChild = (exitsOn: ReadonlyArray<StopSignal>) => {
  const exit = Promise.withResolvers<number>();
  const signals: Array<StopSignal | undefined> = [];
  return {
    signals,
    exit,
    child: {
      kill: (signal?: StopSignal) => {
        signals.push(signal);
        if (signal !== undefined && exitsOn.includes(signal)) exit.resolve(1);
      },
      exited: exit.promise,
    },
  };
};

describe("stopping a child", () => {
  it("sends SIGTERM only, when the child exits within the grace", async () => {
    const { child, signals, exit } = buildSlowChild([]);
    const stopped = Effect.runPromise(stopChild(child, Duration.millis(500)));
    setTimeout(() => exit.resolve(0), 30);

    await stopped;

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("does not return before the child has exited", async () => {
    const { child, exit } = buildSlowChild([]);
    let returned = false;
    const stopped = Effect.runPromise(stopChild(child, Duration.millis(500))).then(() => {
      returned = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(returned).toBe(false);

    exit.resolve(0);
    await stopped;
    expect(returned).toBe(true);
  });

  it("sends SIGKILL after the grace, and waits for the exit that follows", async () => {
    const { child, signals, exit } = buildSlowChild([]);
    let returned = false;
    const stopped = Effect.runPromise(stopChild(child, Duration.millis(30))).then(() => {
      returned = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(returned).toBe(false);

    exit.resolve(137);
    await stopped;
  });

  it("returns when the child exits only after SIGKILL", async () => {
    const { child, signals } = buildSlowChild(["SIGKILL"]);

    await Effect.runPromise(stopChild(child, Duration.millis(30)));

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("returns when the child has already exited and refuses the signal", async () => {
    const child = {
      kill: () => {
        throw new Error("no such process");
      },
      exited: Promise.resolve(0),
    };

    await Effect.runPromise(stopChild(child, Duration.millis(30)));
  });
});
