import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  countAppProcesses,
  formatWithin,
  macLimit,
  readCpuMs,
  readLinuxProcessMemory,
  type ProcessMemory,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

const started: ChildProcess[] = [];

/**
 * Starts a Node process that stays alive and carries `typeSwitch` on its
 * command line, as Chromium's helper processes do. With `child`, it also
 * starts a second such process, which makes that one a grandchild of the
 * caller.
 */
function startFakeHelper(typeSwitch: string, child?: string): ChildProcess {
  // The child's switch travels in the environment, so that the parent's own
  // command line, which holds this script, does not contain it.
  const startChild =
    child === undefined
      ? ""
      : `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", "--", process.env.CHILD_SWITCH], { stdio: "ignore" });`;
  const helper = spawn(
    process.execPath,
    ["-e", `${startChild} setInterval(() => {}, 1e6)`, "--", typeSwitch],
    {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, ...(child === undefined ? {} : { CHILD_SWITCH: child }) },
    },
  );
  started.push(helper);
  return helper;
}

afterEach(() => {
  // Each helper leads its own process group, so one signal ends it and its child.
  for (const helper of started.splice(0)) process.kill(-helper.pid!, "SIGKILL");
});

describe.skipIf(process.platform === "darwin")("readLinuxProcessMemory", () => {
  it("reads the process and its grandchildren, labelled by their --type, with PSS no larger than the resident size", async () => {
    // Chromium forks its GPU and renderer processes from a zygote, so on
    // Linux they are grandchildren of the app, not children.
    const zygote = startFakeHelper("--type=zygote", "--type=renderer");
    const found = await pollUntil(
      async () => {
        const memory = await readLinuxProcessMemory(zygote.pid!);
        return memory.length === 2 ? memory : undefined;
      },
      { timeoutMs: 10_000, intervalMs: 50, timeoutMessage: "the helper never started its child" },
    );

    expect(found.map((sample: ProcessMemory) => sample.label)).toEqual(["Zygote", "Tab"]);
    for (const sample of found) {
      expect(sample.memoryMb).toBeGreaterThan(0);
      expect(sample.memoryMb).toBeLessThanOrEqual(sample.workingSetMb);
    }
    expect(countAppProcesses(found)).toBe(1);
  });

  it("fails for a process that does not exist, rather than reading zero", async () => {
    await expect(readLinuxProcessMemory(2 ** 22 + 1)).rejects.toThrow();
  });
});

describe("readCpuMs", () => {
  it("returns the CPU time of the process in milliseconds", async () => {
    const burnUntil = Date.now() + 400;
    while (Date.now() < burnUntil);
    const usage = process.cpuUsage();
    const expectedMs = (usage.user + usage.system) / 1_000;

    // The kernel counts in hundredths of a second, so allow a few ticks.
    expect(Math.abs((await readCpuMs(process.pid)) - expectedMs)).toBeLessThan(150);
  });
});

describe("formatWithin", () => {
  it("formats a Mac limit as its verdict on a Mac and as not judged elsewhere", () => {
    const formatted = [macLimit(true), macLimit(false)].map(formatWithin);
    expect(formatted).toEqual(
      process.platform === "darwin"
        ? ["yes", "over"]
        : ["not judged (Mac limit)", "not judged (Mac limit)"],
    );
  });

  it("judges a comparison that needs no Mac the same everywhere, and shows a missing limit as a dash", () => {
    expect([true, false, null].map(formatWithin)).toEqual(["yes", "over", "-"]);
  });
});
