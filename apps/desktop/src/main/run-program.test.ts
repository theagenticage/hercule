import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
  describeFailedExit,
  ProgramNotStarted,
  readLastErrorLine,
  removeVariablesWithPrefix,
  runProgram,
} from "./run-program";
import { isProcessRunning, waitUntil, writeShellScript } from "./testing";

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hercule-desktop-run-program-"));
  return () => rmSync(folder, { recursive: true, force: true });
});

/** Writes a shell script with `body` to the temporary folder, and returns its path. */
const writeScript = (name: string, body: string): string => {
  const path = join(folder, name);
  writeShellScript(path, body);
  return path;
};

describe("runProgram", () => {
  const started: Array<number> = [];

  afterEach(() => {
    // Stops what a failed test may have left running, by the PIDs it wrote.
    for (const pid of started.splice(0)) if (isProcessRunning(pid)) process.kill(pid, "SIGKILL");
  });

  it("returns the exit code and what the program wrote, with the environment it is given", async () => {
    const script = writeScript("speak", 'printf "out %s" "$GREETING"; printf "err" >&2; exit 4');
    expect(await Effect.runPromise(runProgram(script, [], { env: { GREETING: "hello" } }))).toEqual(
      { exitCode: 4, stdout: "out hello", stderr: "err" },
    );
  });

  it("closes stdin, so a program that reads it gets no input", async () => {
    const script = writeScript("ask", "if read answer; then exit 0; else exit 7; fi");
    const exit = await Effect.runPromise(runProgram(script, [], { env: {} }));
    expect(exit.exitCode).toBe(7);
  });

  it("runs the program in `cwd`", async () => {
    const script = writeScript("where", "pwd -P");
    const exit = await Effect.runPromise(runProgram(script, [], { env: {}, cwd: folder }));
    // The temporary folder is under /var, which `pwd -P` prints as /private/var.
    expect(exit.stdout.trim()).toBe(realpathSync(folder));
  });

  it("fails with ProgramNotStarted and ENOENT when there is no program at the path", async () => {
    const error = await Effect.runPromise(
      Effect.flip(runProgram(join(folder, "missing"), [], { env: {} })),
    );
    expect(error).toBeInstanceOf(ProgramNotStarted);
    expect(error.code).toBe("ENOENT");
  });

  it("returns when the program exits, and kills what it left running, though that holds its output open", async () => {
    const pids = join(folder, "pids");
    // The background sleep inherits the program's stdout and stderr, so they
    // stay open after the program exits.
    const script = writeScript("leave", `sleep 30 & echo "$!" > "${pids}"; echo done`);
    const startedAt = Date.now();
    const exit = await Effect.runPromise(
      runProgram(script, [], { env: { PATH: "/bin:/usr/bin" } }),
    );
    const leftRunning = Number(readFileSync(pids, "utf8"));
    started.push(leftRunning);
    expect(exit).toEqual({ exitCode: 0, stdout: "done\n", stderr: "" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await waitUntil(() => !isProcessRunning(leftRunning));
  });

  it("kills the program and what it started when the effect is interrupted", async () => {
    const pids = join(folder, "pids");
    // The program starts a child of its own, and waits for it.
    const script = writeScript("hang", `sleep 30 & echo "$$ $!" > "${pids}"; wait`);
    const fiber = Effect.runFork(runProgram(script, [], { env: { PATH: "/bin:/usr/bin" } }));
    await waitUntil(() => existsSync(pids) && readFileSync(pids, "utf8").endsWith("\n"));
    const [program = 0, child = 0] = readFileSync(pids, "utf8").trim().split(" ").map(Number);
    started.push(program, child);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await waitUntil(() => !isProcessRunning(program) && !isProcessRunning(child));
  });
});

describe("readLastErrorLine", () => {
  it.each([
    ["hercule: first\nhercule: last\n\n", "hercule: last"],
    ["  one line  ", "one line"],
    ["", undefined],
    ["\n \n", undefined],
  ])("reads %j as %j", (stderr, line) => expect(readLastErrorLine(stderr)).toBe(line));
});

describe("describeFailedExit", () => {
  it.each([
    [
      { exitCode: 128, stdout: "", stderr: "fatal: not a git repository\n" },
      "fatal: not a git repository",
    ],
    [{ exitCode: 2, stdout: "", stderr: "" }, "Git exited with code 2 and wrote no error."],
    [{ exitCode: null, stdout: "", stderr: "" }, "Git was stopped by a signal before it finished."],
  ])("describes %j as %j", (exit, line) => expect(describeFailedExit(exit, "Git")).toBe(line));
});

describe("removeVariablesWithPrefix", () => {
  it("removes every variable whose name starts with the prefix, and keeps the rest", () => {
    expect(
      removeVariablesWithPrefix(
        { HERCULE_HOME: "/x", HERCULE_PORT: "1", HOME: "/Users/ada", PATH: "/bin" },
        "HERCULE_",
      ),
    ).toEqual({ HOME: "/Users/ada", PATH: "/bin" });
  });
});
