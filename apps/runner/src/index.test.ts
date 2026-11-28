/**
 * Tests the `hercule runner` command line entry. These tests check that:
 *
 * - when the daemon fails to start, the reason is written to the runner's own
 *   log, `<home>/logs/runner.log`, and not only to standard error;
 * - the same holds when plain code on the start path throws, which is not a
 *   typed failure.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { locateRunnerDir } from "@hercule/home";
import { run } from "./index";

const homes: Array<string> = [];

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("hercule runner", () => {
  it("writes why the daemon could not start to the runner's log", async () => {
    // A Home that never joined: the daemon fails at once on the missing runner.json.
    const home = mkdtempSync(join(tmpdir(), "hercule-runner-entry-"));
    homes.push(home);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await run(["--home", home]);

    expect(process.exitCode).toBe(1);
    const logPath = join(home, "logs", "runner.log");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("the runner stopped");
    expect(log).toContain("runner.json");
  });

  it("writes an exception thrown on the start path to the runner's log", async () => {
    const home = mkdtempSync(join(tmpdir(), "hercule-runner-entry-"));
    homes.push(home);
    mkdirSync(locateRunnerDir(home), { recursive: true });
    writeFileSync(
      join(locateRunnerDir(home), "runner.json"),
      JSON.stringify({
        runnerId: "0199e0e7-0000-7000-8000-000000000000",
        credential: "x",
        controllerUrl: "http://127.0.0.1:9",
        controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
        controllerPublicKey: "AAAA",
        storageDirectory: "deadbeefdeadbeef",
      }),
    );
    // A file where the storage folder belongs: creating the folder throws EEXIST.
    writeFileSync(join(locateRunnerDir(home), "deadbeefdeadbeef"), "");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await run(["--home", home]).catch(() => undefined);

    const log = readFileSync(join(home, "logs", "runner.log"), "utf8");
    expect(log).toContain("the runner stopped");
    expect(log).toContain("EEXIST");
  });
});
