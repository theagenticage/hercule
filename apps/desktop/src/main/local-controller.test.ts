import { beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { ControllerConnection } from "./controller-connection";
import {
  BinaryCommandFailed,
  BinaryNotFound,
  InstalledBinary,
  type ServiceReport,
} from "./installed-binary";
import {
  ControllerAlreadySaved,
  LocalController,
  makeLocalControllerLayer,
  NoLogsFolderSeen,
  StartAlreadyRunning,
} from "./local-controller";
import { LoginShell, LoginShellPathError } from "./login-shell-path";
import { makeTemporarySettingsFile, type TemporarySettingsFile } from "./testing";

const ORIGIN = "http://127.0.0.1:4937";
const LOGS = "/Users/ada/.hercule/logs";

/** What the binary reports for a Mac whose Service Unit runs Hercule's controller. */
const CONTROLLER_REPORT: ServiceReport = {
  installed: true,
  running: true,
  role: "serve",
  controllerUrl: ORIGIN,
  logsDir: LOGS,
};

/** What the binary reports for a Mac with no Service Unit. */
const FRESH_REPORT: ServiceReport = {
  installed: false,
  running: false,
  role: null,
  controllerUrl: ORIGIN,
  logsDir: LOGS,
};

/** What the binary reports for a Mac whose Service Unit runs a runner. */
const RUNNER_REPORT: ServiceReport = { ...CONTROLLER_REPORT, role: "runner", running: false };

type BinaryResult = Effect.Effect<ServiceReport, BinaryNotFound | BinaryCommandFailed>;

/** How the fakes behave; a test changes what it needs. */
interface Fakes {
  status: BinaryResult;
  install: BinaryResult;
  path: Effect.Effect<string, LoginShellPathError>;
  /** Whether Hercule answers at the `checks`-th check of an origin, counted from 1. */
  answers: (checks: number) => boolean;
}

let settingsFile: TemporarySettingsFile;
let fakes: Fakes;
/** What the service asked of the fakes, in order. */
let calls: Array<string>;

beforeEach(() => {
  settingsFile = makeTemporarySettingsFile();
  calls = [];
  fakes = {
    status: Effect.succeed(FRESH_REPORT),
    install: Effect.succeed(CONTROLLER_REPORT),
    path: Effect.succeed("/opt/homebrew/bin:/usr/bin:/bin"),
    answers: () => true,
  };
  return settingsFile.remove;
});

/** Records `call`, then runs `effect`, read when it runs, so a test can change the fakes first. */
const recordThen = <A, E>(call: string, effect: () => Effect.Effect<A, E>) =>
  Effect.suspend(() => {
    calls.push(call);
    return effect();
  });

/** Builds the service on the temporary settings file and the fakes. */
const buildLayer = () => {
  let checks = 0;
  return makeLocalControllerLayer((folder) =>
    recordThen(`openFolder ${folder}`, () => Effect.void),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        settingsFile.layer,
        Layer.succeed(InstalledBinary)({
          readStatus: recordThen("status", () => fakes.status),
          install: (path) => recordThen(`install ${path}`, () => fakes.install),
          readSetupUrl: Effect.die("not used"),
        }),
        Layer.succeed(LoginShell)({ readPath: recordThen("readPath", () => fakes.path) }),
        Layer.succeed(ControllerConnection)({
          save: () => Effect.die("not used"),
          takePastedSetupToken: () => Effect.die("not used"),
          saveIfAnswering: (origin) =>
            Effect.sync(() => {
              checks++;
              calls.push(`check ${origin}`);
              return fakes.answers(checks);
            }),
        }),
      ),
    ),
  );
};

/**
 * Runs `use` on a new service with a test clock, which the test moves on by
 * `elapsed` once `use` has started, and returns what `use` returned or
 * failed with.
 */
const run = <A, E>(
  use: (service: LocalController["Service"]) => Effect.Effect<A, E>,
  elapsed: Duration.Input = "0 millis",
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.result(LocalController.use(use)));
      yield* TestClock.adjust(elapsed);
      const result = yield* Fiber.join(fiber);
      return result._tag === "Success" ? result.success : result.failure;
    }).pipe(Effect.provide(Layer.merge(buildLayer(), TestClock.layer()))),
  );

const find = (service: LocalController["Service"]) => service.find;
const start = (service: LocalController["Service"]) => service.start;

const saveControllerUrl = () =>
  writeFileSync(settingsFile.path, JSON.stringify({ controllerUrl: ORIGIN }));

describe("LocalController.find", () => {
  it("saves Hercule's controller when it answers at the address the binary reports", async () => {
    fakes.status = Effect.succeed(CONTROLLER_REPORT);
    expect(await run(find)).toEqual({ _tag: "Saved", origin: ORIGIN });
    expect(calls).toEqual(["status", `check ${ORIGIN}`]);
  });

  it("returns Fresh when nothing answers there", async () => {
    fakes.answers = () => false;
    expect(await run(find)).toEqual({ _tag: "Fresh", problem: null });
  });

  it("returns Fresh, and checks nothing, when the Home names no address", async () => {
    fakes.status = Effect.succeed({ ...FRESH_REPORT, controllerUrl: null });
    expect(await run(find)).toEqual({ _tag: "Fresh", problem: null });
    expect(calls).toEqual(["status"]);
  });

  it("returns Fresh when there is no binary", async () => {
    fakes.status = Effect.fail(new BinaryNotFound({ message: "none" }));
    expect(await run(find)).toEqual({ _tag: "Fresh", problem: null });
  });

  it("returns Fresh with the line the status failed with", async () => {
    fakes.status = Effect.fail(new BinaryCommandFailed({ line: "launchctl failed." }));
    expect(await run(find)).toEqual({ _tag: "Fresh", problem: "launchctl failed." });
  });

  it("returns Runner, and checks nothing, when the Service Unit runs a runner", async () => {
    fakes.status = Effect.succeed(RUNNER_REPORT);
    expect(await run(find)).toEqual({ _tag: "Runner", running: false });
    expect(calls).toEqual(["status"]);
  });

  it("is refused when a controller URL is saved", async () => {
    saveControllerUrl();
    expect(await run(find)).toEqual(new ControllerAlreadySaved());
    expect(calls).toEqual([]);
  });
});

describe("LocalController.start", () => {
  it("installs with the login shell's PATH, waits for Hercule to answer, and saves it", async () => {
    fakes.answers = (checks) => checks === 3;
    expect(await run(start, "1 second")).toEqual({ _tag: "Saved", origin: ORIGIN });
    expect(calls).toEqual([
      "status",
      "readPath",
      "install /opt/homebrew/bin:/usr/bin:/bin",
      `check ${ORIGIN}`,
      `check ${ORIGIN}`,
      `check ${ORIGIN}`,
    ]);
  });

  it("returns NoAnswer when nothing answers within 30 seconds, checking every half second", async () => {
    fakes.answers = () => false;
    expect(await run(start, "31 seconds")).toEqual({
      _tag: "NoAnswer",
      address: ORIGIN,
      logsDir: LOGS,
    });
    // A check at the start, then one each half second up to 30 seconds.
    expect(calls.filter((call) => call.startsWith("check"))).toHaveLength(61);
  });

  it("returns Runner, and installs nothing, when the Service Unit runs a runner", async () => {
    fakes.status = Effect.succeed(RUNNER_REPORT);
    expect(await run(start)).toEqual({ _tag: "Runner", running: false });
    expect(calls).toEqual(["status"]);
  });

  it("returns Runner when the install set up a runner", async () => {
    fakes.install = Effect.succeed(RUNNER_REPORT);
    expect(await run(start)).toEqual({ _tag: "Runner", running: false });
    expect(calls).not.toContain(`check ${ORIGIN}`);
  });

  it("returns NotInstalled when there is no binary", async () => {
    fakes.status = Effect.fail(new BinaryNotFound({ message: "none" }));
    expect(await run(start)).toEqual({ _tag: "NotInstalled" });
  });

  it("returns StartError with the line the status failed with", async () => {
    fakes.status = Effect.fail(new BinaryCommandFailed({ line: "launchctl failed." }));
    expect(await run(start)).toEqual({ _tag: "StartError", line: "launchctl failed." });
  });

  it("returns StartError, and installs nothing, when the login shell's PATH cannot be read", async () => {
    fakes.path = Effect.fail(new LoginShellPathError({ reason: "Your login shell hangs." }));
    expect(await run(start)).toEqual({ _tag: "StartError", line: "Your login shell hangs." });
    expect(calls).toEqual(["status", "readPath"]);
  });

  it("returns StartError with the line the install failed with", async () => {
    fakes.install = Effect.fail(new BinaryCommandFailed({ line: "Port 4937 is in use." }));
    expect(await run(start)).toEqual({ _tag: "StartError", line: "Port 4937 is in use." });
  });

  it("returns StartError when the install reports no address", async () => {
    fakes.install = Effect.succeed({ ...CONTROLLER_REPORT, controllerUrl: null });
    const outcome = await run(start);
    expect(outcome).toMatchObject({ _tag: "StartError" });
  });

  it("stops an install that runs for 90 seconds, and returns NoAnswer", async () => {
    fakes.install = Effect.never;
    expect(await run(start, "90 seconds")).toEqual({
      _tag: "NoAnswer",
      address: ORIGIN,
      logsDir: LOGS,
    });
  });

  it("stops an install that runs for 90 seconds, and returns StartError with no address known", async () => {
    fakes.status = Effect.succeed({ ...FRESH_REPORT, controllerUrl: null });
    fakes.install = Effect.never;
    expect(await run(start, "90 seconds")).toEqual({
      _tag: "StartError",
      line: "`hercule service install` did not finish within 90 seconds, so the app stopped it.",
    });
  });

  it("refuses a second start while one runs, and accepts one after", async () => {
    fakes.answers = () => false;
    const outcomes = await run((service) =>
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(service.start);
        yield* Effect.yieldNow;
        const second = yield* Effect.flip(service.start);
        yield* TestClock.adjust("31 seconds");
        const firstOutcome = yield* Fiber.join(first);
        fakes.answers = () => true;
        return [firstOutcome._tag, second, (yield* service.start)._tag];
      }),
    );
    expect(outcomes).toEqual(["NoAnswer", new StartAlreadyRunning(), "Saved"]);
  });

  it("is refused when a controller URL is saved", async () => {
    saveControllerUrl();
    expect(await run(start)).toEqual(new ControllerAlreadySaved());
    expect(calls).toEqual([]);
  });
});

describe("LocalController.showLogsFolder", () => {
  it("is refused before the binary has reported a logs folder", async () => {
    expect(await run((service) => service.showLogsFolder)).toEqual(new NoLogsFolderSeen());
  });

  it("opens the logs folder the binary reported last", async () => {
    await run((service) => Effect.andThen(service.find, service.showLogsFolder));
    expect(calls.at(-1)).toBe(`openFolder ${LOGS}`);
  });
});
