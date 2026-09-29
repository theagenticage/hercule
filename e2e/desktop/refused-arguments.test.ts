/**
 * Tests that the release package refuses to start with a command-line
 * argument that is not on its short list (spec 17, §Security baseline),
 * because many switches would let another program read the signed-in
 * session. The cases are a sample of those, some written the ways Chromium
 * still reads as a switch, with leading whitespace or one dash. An argument
 * is refused whenever the app's Node inspector is closed, and the release
 * package's fuses keep it closed, even when it is asked for with `--inspect`.
 * That the release package starts with the arguments on the list, those
 * `buildAppArgs` passes, is tested by every test that starts it.
 *
 * The app is started with `child_process` rather than Playwright: Playwright
 * waits for the app to open DevTools, which a refused app never does. Run
 * `pnpm build:desktop` first.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { buildAppArgs, buildAppEnv, findExecutable } from "../../apps/desktop/scripts/packaged-app";
import { createUserDataDirForTest, waitForExit } from "./harness";

describe("the release package", () => {
  it.each([
    { refused: "--remote-debugging-port=0", args: ["--remote-debugging-port=0"] },
    { refused: "--remote-debugging-pipe", args: ["--remote-debugging-pipe"] },
    { refused: "--use-mock-keychain", args: ["--use-mock-keychain"] },
    {
      refused: "--log-net-log=/dev/null",
      args: ["--log-net-log=/dev/null", "--net-log-capture-mode=Everything"],
    },
    { refused: "--proxy-server=http://127.0.0.1:9", args: ["--proxy-server=http://127.0.0.1:9"] },
    { refused: "--ignore-certificate-errors", args: ["--ignore-certificate-errors"] },
    {
      refused: "--host-resolver-rules=MAP * 127.0.0.1",
      args: ["--host-resolver-rules=MAP * 127.0.0.1"],
    },
    // Chromium trims whitespace from an argument before it reads a switch.
    { refused: " --remote-debugging-port=0", args: [" --remote-debugging-port=0"] },
    { refused: "\t--log-net-log=/dev/null", args: ["\t--log-net-log=/dev/null"] },
    // Chromium reads a switch with one dash as it reads one with two.
    { refused: "-remote-debugging-port=0", args: ["-remote-debugging-port=0"] },
    // The fuses ignore `--inspect`, so the inspector stays closed, and the
    // argument is refused like any other.
    { refused: "--inspect=0", args: ["--inspect=0", "--remote-debugging-port=0"] },
  ])("refuses $refused and exits with code 1, started with $args", async ({ refused, args }) => {
    const child = spawn(
      findExecutable("release"),
      [...buildAppArgs(createUserDataDirForTest()), ...args],
      {
        env: buildAppEnv(),
        // `--remote-debugging-pipe` talks over file descriptors 3 and 4, so
        // they are pipes, as they would be for a program that used the switch.
        stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const closed = once(child, "close");

    expect(await waitForExit(child, "the release app")).toBe(1);
    await closed;
    expect(stderr).toContain(
      `Hercule does not start with the argument ${JSON.stringify(refused)}: it refuses every command-line argument but a few, because some would let another program read your signed-in session. Start it without that argument.`,
    );
  });
});
