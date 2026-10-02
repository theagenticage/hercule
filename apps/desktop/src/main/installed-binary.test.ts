import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import {
  BinaryCommandFailed,
  BinaryNotFound,
  describeBinaryFailure,
  InstalledBinary,
  makeInstalledBinaryLayer,
} from "./installed-binary";
import { isProcessRunning, waitUntil, writeShellScript } from "./testing";

/** What a stand-in binary prints for `service status --json`: every field `--json` prints. */
const STATUS_JSON = JSON.stringify({
  installed: true,
  running: true,
  pid: 4242,
  role: "serve",
  home: "/Users/ada/.hercule",
  unitFile: "/Users/ada/Library/LaunchAgents/dev.hercule.controller.plist",
  controllerUrl: "http://127.0.0.1:4937",
  logsDir: "/Users/ada/.hercule/logs",
});

let folder: string;
let binary: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hercule-desktop-binary-"));
  binary = join(folder, "hercule");
  return () => rmSync(folder, { recursive: true, force: true });
});

// A HERCULE_* variable in main's environment must not reach the binary.
beforeEach(() => {
  process.env.HERCULE_HOME = "/tmp/not-the-default-home";
});
afterEach(() => {
  delete process.env.HERCULE_HOME;
});

/**
 * Writes a stand-in binary that records its arguments, `HERCULE_HOME` and
 * `PATH` in `calls`, one line per run, then runs `body`.
 */
const writeStandIn = (body: string): void => {
  const calls = join(folder, "calls");
  writeShellScript(
    binary,
    `printf '%s|%s|%s\\n' "$*" "\${HERCULE_HOME-unset}" "$PATH" >> "${calls}"\n${body}`,
  );
};

/** Returns each run of the stand-in: its arguments, its `HERCULE_HOME`, and its `PATH`. */
const readCalls = (): Array<string> =>
  readFileSync(join(folder, "calls"), "utf8").trim().split("\n");

/** Runs `use` on the service built on the stand-in, and returns what it returned or failed with. */
const run = <A, E>(use: (service: InstalledBinary["Service"]) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.provide(InstalledBinary.use(use), makeInstalledBinaryLayer(binary)).pipe(
      Effect.match({
        onSuccess: (success) => ({ _tag: "Success", success }) as const,
        onFailure: (failure) => ({ _tag: "Failure", failure }) as const,
      }),
    ),
  );

describe("InstalledBinary", () => {
  it("reads the status, without any HERCULE_* variable", async () => {
    writeStandIn(`printf '%s' '${STATUS_JSON}'`);
    const result = await run((service) => service.readStatus);
    expect(result).toEqual({
      _tag: "Success",
      success: {
        installed: true,
        running: true,
        role: "serve",
        controllerUrl: "http://127.0.0.1:4937",
        logsDir: "/Users/ada/.hercule/logs",
      },
    });
    expect(readCalls()).toEqual([`service status --json|unset|${process.env.PATH ?? ""}`]);
  });

  it("installs with the PATH it is given", async () => {
    writeStandIn(`printf '%s' '${STATUS_JSON}'`);
    const result = await run((service) => service.install("/opt/tools/bin:/usr/bin:/bin"));
    expect(result._tag).toBe("Success");
    expect(readCalls()).toEqual(["service install --json|unset|/opt/tools/bin:/usr/bin:/bin"]);
  });

  it("fails with the last line of stderr, without its prefix", async () => {
    writeStandIn(
      "echo 'hercule: a first problem' >&2; echo 'hercule: Port 4937 is in use. Free it.' >&2; exit 1",
    );
    expect(await run((service) => service.readStatus)).toEqual({
      _tag: "Failure",
      failure: new BinaryCommandFailed({ line: "Port 4937 is in use. Free it." }),
    });
  });

  it("fails when the status does not decode", async () => {
    writeStandIn(`printf '%s' '{"installed":"yes"}'`);
    expect(await run((service) => service.readStatus)).toEqual({
      _tag: "Failure",
      failure: new BinaryCommandFailed({
        line: "`hercule service status --json` printed a status the app cannot read. Install Hercule again.",
      }),
    });
  });

  it("fails when the controller URL is not an origin", async () => {
    writeStandIn(
      `printf '%s' '${STATUS_JSON.replace("http://127.0.0.1:4937", "http://127.0.0.1:4937/setup")}'`,
    );
    const result = await run((service) => service.readStatus);
    expect(result._tag).toBe("Failure");
  });

  it("stops the status command after 10 seconds", async () => {
    const pidFile = join(folder, "pid");
    writeStandIn(`echo $$ > "${pidFile}"; exec /bin/sleep 30`);
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.provide(
            InstalledBinary.use((service) => Effect.flip(service.readStatus)),
            makeInstalledBinaryLayer(binary),
          ),
        );
        yield* Effect.promise(() => waitUntil(() => existsSync(pidFile)));
        yield* TestClock.adjust("10 seconds");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(outcome).toEqual(
      new BinaryCommandFailed({
        line: "`hercule service status` did not finish within 10 seconds.",
      }),
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    await waitUntil(() => !isProcessRunning(pid));
  });

  it("fails with BinaryNotFound when there is no binary", async () => {
    expect(await run((service) => service.readStatus)).toEqual({
      _tag: "Failure",
      failure: new BinaryNotFound({ message: `There is no Hercule binary at ${binary}.` }),
    });
  });

  it("reads the setup URL, or null when the Home holds none", async () => {
    writeStandIn("echo 'http://127.0.0.1:4937/setup?token=abc'");
    expect(await run((service) => service.readSetupUrl)).toEqual({
      _tag: "Success",
      success: "http://127.0.0.1:4937/setup?token=abc",
    });
    writeStandIn("echo 'hercule: this Home is set up' >&2; exit 3");
    expect(await run((service) => service.readSetupUrl)).toEqual({
      _tag: "Success",
      success: null,
    });
    expect(readCalls().map((call) => call.split("|")[0])).toEqual(["setup-url", "setup-url"]);
  });
});

describe("describeBinaryFailure", () => {
  it.each([
    [{ exitCode: 1, stdout: "", stderr: "hercule: it broke\n" }, "it broke"],
    [{ exitCode: 1, stdout: "", stderr: "warning: no prefix" }, "warning: no prefix"],
    [{ exitCode: 2, stdout: "", stderr: "" }, "Hercule exited with code 2 and wrote no error."],
    [
      { exitCode: null, stdout: "", stderr: "" },
      "Hercule was stopped by a signal before it finished.",
    ],
  ])("describes %j as %j", (exit, line) => expect(describeBinaryFailure(exit)).toBe(line));
});
