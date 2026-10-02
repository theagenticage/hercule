import { describe, expect, it } from "vitest";
import { findRefusedArgument, readBinaryPathArgument } from "./refused-arguments";

/** The arguments the end-to-end tests start the app with. */
const TEST_ARGS = ["-ApplePersistenceIgnoreState", "YES", "--user-data-dir=/tmp/hercule-e2e"];

describe("findRefusedArgument", () => {
  it.each([
    "--remote-debugging-port=0",
    "--remote-debugging-pipe",
    "--use-mock-keychain",
    "--log-net-log=/tmp/net.json",
    "--proxy-server=http://127.0.0.1:8080",
    "--ignore-certificate-errors",
    "--host-resolver-rules=MAP * 127.0.0.1",
    "--inspect=0",
    // Chromium trims whitespace from an argument before it reads a switch.
    " --remote-debugging-port=9337",
    "\t--log-net-log=/tmp/x.json",
    "\n--remote-debugging-port=0",
    // Chromium reads a switch with one dash as it reads one with two.
    "-remote-debugging-port=0",
    "-user-data-dir=/tmp/hercule",
    "--User-Data-Dir=/tmp/hercule",
    // Chromium takes a switch's value only after `=`.
    "--user-data-dir",
    // An argument that is not a switch.
    "/Users/someone/notes.txt",
    "yes",
  ])("refuses %j in a packaged app with the inspector closed", (arg) => {
    expect(findRefusedArgument([...TEST_ARGS, arg], true, false)).toBe(arg);
  });

  it("refuses `--` followed by a switch, at the `--`", () => {
    const args = [...TEST_ARGS, "--", "--remote-debugging-port=0"];
    expect(findRefusedArgument(args, true, false)).toBe("--");
  });

  it("names the first refused argument when there are several", () => {
    const args = ["--inspect=0", "--remote-debugging-port=0"];
    expect(findRefusedArgument(args, true, false)).toBe("--inspect=0");
  });

  it.each([["-ApplePersistenceIgnoreState"], ["YES"], ["--user-data-dir=/tmp/hercule e2e"]])(
    "starts with %j alone",
    (arg) => {
      expect(findRefusedArgument([arg], true, false)).toBeUndefined();
    },
  );

  it("starts with the arguments the end-to-end tests pass", () => {
    expect(findRefusedArgument(TEST_ARGS, true, false)).toBeUndefined();
  });

  it("starts with no arguments, as macOS opens it", () => {
    expect(findRefusedArgument([], true, false)).toBeUndefined();
  });

  const refusedArgs = ["--remote-debugging-port=0", "--use-mock-keychain"];

  it("refuses nothing while the inspector is open, as it is in the test package", () => {
    expect(findRefusedArgument(refusedArgs, true, true)).toBeUndefined();
  });

  it("refuses nothing in development", () => {
    expect(findRefusedArgument(refusedArgs, false, false)).toBeUndefined();
  });
});

describe("readBinaryPathArgument", () => {
  const args = [...TEST_ARGS, "--hercule-binary=/tmp/stand-in/hercule"];

  it("reads the path in a development run and with the inspector open", () => {
    expect(readBinaryPathArgument(args, false, false)).toBe("/tmp/stand-in/hercule");
    expect(readBinaryPathArgument(args, true, true)).toBe("/tmp/stand-in/hercule");
  });

  it("ignores the switch in a packaged app with the inspector closed, which refuses it", () => {
    expect(readBinaryPathArgument(args, true, false)).toBeUndefined();
    expect(findRefusedArgument(args, true, false)).toBe("--hercule-binary=/tmp/stand-in/hercule");
  });

  it("returns undefined without the switch", () => {
    expect(readBinaryPathArgument(TEST_ARGS, false, false)).toBeUndefined();
  });
});
