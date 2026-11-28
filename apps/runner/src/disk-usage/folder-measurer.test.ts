/**
 * Tests measuring a folder in a real child process: the `measure-disk-usage`
 * verb of the dispatcher's entry script, and a child that outlives its deadline.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Duration, Effect } from "effect";
import { makeFolderMeasurer } from "./folder-measurer";
import { walkFolder } from "./walker";

const MAIN = fileURLToPath(new URL("../../../../packages/hercule/src/main.ts", import.meta.url));

const scratch: string[] = [];

afterEach(() => {
  for (const folder of scratch.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const makeScratch = (): string => {
  const folder = mkdtempSync(join(tmpdir(), "hercule-measurer-"));
  scratch.push(folder);
  return folder;
};

/** Runs the dispatcher's entry script as the walker, without `nice`: Bun.main is not that script under the test runner. */
const measureThroughVerb = makeFolderMeasurer({
  buildCommand: (folder) => [process.execPath, MAIN, "measure-disk-usage", folder],
});

describe("makeFolderMeasurer", () => {
  it("returns what the walker finds, from the verb of the binary", async () => {
    const folder = makeScratch();
    mkdirSync(join(folder, "src"));
    writeFileSync(join(folder, "src", "a.txt"), Buffer.alloc(50_000, 1));

    const usage = await Effect.runPromise(measureThroughVerb(folder));

    expect(usage).toEqual(walkFolder(folder));
  });

  it("fails with the walker's reason when the folder is missing", async () => {
    const missing = join(makeScratch(), "missing");

    const outcome = await Effect.runPromise(Effect.flip(measureThroughVerb(missing)));

    expect(outcome.message).toContain(missing);
  });

  it("kills a walk that passes its deadline, and reports why", async () => {
    const folder = makeScratch();
    const pidFile = join(folder, "pid");
    const measure = makeFolderMeasurer({
      deadline: Duration.millis(300),
      buildCommand: () => ["sh", "-c", `echo $$ > '${pidFile}'; exec sleep 30`],
    });

    const failure = await Effect.runPromise(Effect.flip(measure(folder)));

    expect(failure.message).toBe("Measuring took longer than 10 minutes");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    // `kill -0` fails once the process is gone and reaped.
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stops a walker that prints far more than a disk usage, and reports why", async () => {
    const measure = makeFolderMeasurer({
      buildCommand: () => ["sh", "-c", "yes"],
    });

    const failure = await Effect.runPromise(Effect.flip(measure(makeScratch())));

    expect(failure.message).toBe(
      "The walker printed far more than a disk usage, so it was stopped",
    );
  });
});
