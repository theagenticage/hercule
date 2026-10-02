import { beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { findBetweenMarkers, LoginShellPathError, readLoginShellPath } from "./login-shell-path";
import { isProcessRunning, waitUntil, writeShellScript } from "./testing";

let folder: string;
let shell: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hercule-desktop-login-shell-"));
  shell = join(folder, "fake-shell");
  return () => rmSync(folder, { recursive: true, force: true });
});

/**
 * Writes a fake login shell that runs `startup`, as a user's startup files
 * would, then the command it is given. It is started as `<shell> -ilc
 * <command>`, so the command is its second argument.
 */
const writeFakeShell = (startup: string): void =>
  writeShellScript(shell, `[ "$1" = "-ilc" ] || exit 64\n${startup}\neval "$2"`);

describe("readLoginShellPath", () => {
  it("returns the PATH the startup files set, without what they print", async () => {
    writeFakeShell(
      'echo "Welcome back!"; PATH="/opt/homebrew/bin:/usr/bin:/bin"; printf "%s" "$PATH"',
    );
    expect(await Effect.runPromise(readLoginShellPath(shell))).toBe(
      "/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  it("fails when the shell exits with an error", async () => {
    writeShellScript(shell, "exit 2");
    expect(await Effect.runPromise(Effect.flip(readLoginShellPath(shell)))).toEqual(
      new LoginShellPathError({
        reason: `Your login shell, ${shell}, exited with code 2 while it printed your PATH.`,
      }),
    );
  });

  it("fails when the shell prints no PATH", async () => {
    writeFakeShell('PATH=""');
    expect(await Effect.runPromise(Effect.flip(readLoginShellPath(shell)))).toEqual(
      new LoginShellPathError({ reason: `Your login shell, ${shell}, did not print your PATH.` }),
    );
  });

  it("fails when the shell cannot be started", async () => {
    const error = await Effect.runPromise(Effect.flip(readLoginShellPath(join(folder, "missing"))));
    expect(error.reason).toMatch(/^Your login shell, .*missing, could not be started: /);
  });

  it("stops a shell that hangs after 5 seconds", async () => {
    const pidFile = join(folder, "pid");
    // A startup file that waits for input it never gets would hang the same way.
    writeFakeShell(`echo $$ > "${pidFile}"; exec /bin/sleep 30`);
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.flip(readLoginShellPath(shell)));
        yield* Effect.promise(() => waitUntil(() => existsSync(pidFile)));
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(error.reason).toBe(
      `Your login shell, ${shell}, did not print your PATH within 5 seconds. Check that its startup files do not wait for input.`,
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    await waitUntil(() => !isProcessRunning(pid));
  });
});

describe("findBetweenMarkers", () => {
  it.each([
    ["hello M/usr/binM bye", "/usr/bin"],
    ["MM", ""],
    ["no marker", null],
    ["one M only", null],
  ])("finds in %j %j", (output, found) => expect(findBetweenMarkers(output, "M")).toBe(found));
});
