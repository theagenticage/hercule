/**
 * Tests the `hercule runner` command line entry. These tests check that:
 *
 * - when the daemon fails to start, the reason is written to the runner's own
 *   log, `<home>/logs/runner.log`, and not only to standard error.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
