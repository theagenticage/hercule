import { beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import type { ControllerCheckOutcome } from "./controller-check";
import { AppSettings } from "./app-settings";
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
  loginShellPath: Effect.Effect<string, LoginShellPathError>;
  /** Returns the outcome of the `checks`-th connect check, counted from 1. */
  check: (checks: number) => ControllerCheckOutcome;
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
    loginShellPath: Effect.succeed("/opt/homebrew/bin:/usr/bin:/bin"),
    check: () => ({ _tag: "Ready" }),
  };
  return settingsFile.remove;
});

/** Records `call`, then runs `effect`, read when it runs, so a test can change the fakes first. */
const recordThen = <A, E>(call: string, effect: () => Effect.Effect<A, E>) =>
  Effect.suspend(() => {
    calls.push(call);
    return effect();
  });

const saveControllerUrl = () =>
  writeFileSync(settingsFile.path, JSON.stringify({ controllerUrl: ORIGIN }));

/** Builds the service on the temporary settings file and the fakes. */
const buildLayer = () => {
  let checks = 0;
  return makeLocalControllerLayer((folder) =>
    recordThen(`openFolder ${folder}`, () => Effect.void),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(InstalledBinary)({
          readStatus: recordThen("status", () => fakes.status),
          install: (path) => recordThen(`install ${path}`, () => fakes.install),
          readSetupUrl: Effect.die("not used"),
        }),
        Layer.succeed(LoginShell)({
          readPath: recordThen("readPath", () => fakes.loginShellPath),
        }),
        Layer.effect(ControllerConnection)(
          Effect.gen(function* () {
            const settings = yield* AppSettings;
            return {
              save: () => Effect.die("not used"),
              takePastedSetupToken: () => Effect.die("not used"),
              check: (origin: string) =>
                recordThen(`check ${origin}`, () => Effect.sync(() => fakes.check(++checks))),
              // Saves the URL as the real service does, so that a later
              // `find` or `start` sees it saved.
              saveAndReload: (origin: string) =>
                recordThen(`save ${origin}`, () =>
                  Effect.orDie(settings.saveControllerUrl(origin)),
                ),
            };
          }),
        ),
      ).pipe(Layer.provideMerge(settingsFile.layer)),
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

describe("LocalController.find", () => {
  it("saves Hercule's controller when it answers at the address the binary reports", async () => {
    fakes.status = Effect.succeed(CONTROLLER_REPORT);
    expect(await run(find)).toEqual({ _tag: "Saved", origin: ORIGIN });
    expect(calls).toEqual(["status", `check ${ORIGIN}`, `save ${ORIGIN}`]);
  });

  it("saves a controller that answers but is not set up", async () => {
    fakes.check = () => ({ _tag: "SetupIncomplete" });
    expect(await run(find)).toEqual({ _tag: "Saved", origin: ORIGIN });
  });

  it.each<ControllerCheckOutcome>([
    { _tag: "Unreachable" },
    { _tag: "NotController" },
    { _tag: "Redirected", targetOrigin: "http://127.0.0.1:5000" },
  ])("returns Fresh, and saves nothing, when the check finds %j", async (outcome) => {
    fakes.check = () => outcome;
    expect(await run(find)).toEqual({ _tag: "Fresh", problem: null });
    expect(calls).toEqual(["status", `check ${ORIGIN}`]);
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
    fakes.check = (checks) => (checks === 3 ? { _tag: "Ready" } : { _tag: "Unreachable" });
    expect(await run(start, "1 second")).toEqual({ _tag: "Saved", origin: ORIGIN });
    expect(calls).toEqual([
      "status",
      "readPath",
      "install /opt/homebrew/bin:/usr/bin:/bin",
      `check ${ORIGIN}`,
      `check ${ORIGIN}`,
      `check ${ORIGIN}`,
      `save ${ORIGIN}`,
    ]);
  });

  it("checks a Hercule that runs already, and installs nothing", async () => {
    fakes.status = Effect.succeed(CONTROLLER_REPORT);
    expect(await run(start)).toEqual({ _tag: "Saved", origin: ORIGIN });
    expect(calls).toEqual(["status", `check ${ORIGIN}`, `save ${ORIGIN}`]);
  });

  it("installs again when the Service Unit has Hercule but it is not running", async () => {
    fakes.status = Effect.succeed({ ...CONTROLLER_REPORT, running: false });
    expect(await run(start)).toEqual({ _tag: "Saved", origin: ORIGIN });
    expect(calls).toContain("install /opt/homebrew/bin:/usr/bin:/bin");
  });

  it("returns NoAnswer when nothing answers within 30 seconds, checking every half second", async () => {
    fakes.check = () => ({ _tag: "Unreachable" });
    expect(await run(start, "31 seconds")).toEqual({
      _tag: "NoAnswer",
      address: ORIGIN,
      logsDir: LOGS,
    });
    // A check at the start, then one each half second until 30 seconds.
    expect(calls.filter((call) => call.startsWith("check"))).toHaveLength(60);
    expect(calls).not.toContain(`save ${ORIGIN}`);
  });

  it("stops waiting at once when something answers that is not a controller", async () => {
    fakes.check = (checks) => (checks === 2 ? { _tag: "NotController" } : { _tag: "Unreachable" });
    expect(await run(start, "1 second")).toEqual({ _tag: "NotController", origin: ORIGIN });
    expect(calls.filter((call) => call.startsWith("check"))).toHaveLength(2);
    expect(calls).not.toContain(`save ${ORIGIN}`);
  });

  it("returns the check's outcome, with its details, when Hercule redirects", async () => {
    fakes.check = () => ({ _tag: "Redirected", targetOrigin: "https://example.com" });
    expect(await run(start)).toEqual({
      _tag: "Redirected",
      origin: ORIGIN,
      targetOrigin: "https://example.com",
    });
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

  it("returns NotInstalled when the binary is gone by the install", async () => {
    fakes.install = Effect.fail(new BinaryNotFound({ message: "none" }));
    expect(await run(start)).toEqual({ _tag: "NotInstalled" });
  });

  it("returns StartError with the line the status failed with", async () => {
    fakes.status = Effect.fail(new BinaryCommandFailed({ line: "launchctl failed." }));
    expect(await run(start)).toEqual({ _tag: "StartError", line: "launchctl failed." });
  });

  it("returns StartError, and installs nothing, when the login shell's PATH cannot be read", async () => {
    fakes.loginShellPath = Effect.fail(
      new LoginShellPathError({ reason: "Your login shell hangs." }),
    );
    expect(await run(start)).toEqual({ _tag: "StartError", line: "Your login shell hangs." });
    expect(calls).toEqual(["status", "readPath"]);
  });

  it("returns StartError with the line the install failed with", async () => {
    fakes.install = Effect.fail(new BinaryCommandFailed({ line: "Port 4937 is in use." }));
    expect(await run(start)).toEqual({ _tag: "StartError", line: "Port 4937 is in use." });
  });

  it("returns StartError, and checks nothing, when the install reports no address", async () => {
    fakes.install = Effect.succeed({ ...CONTROLLER_REPORT, controllerUrl: null });
    expect(await run(start)).toEqual({
      _tag: "StartError",
      line: "Hercule was started, but its config.toml names no address the app can open. Run `hercule service status` in Terminal to see why.",
    });
    expect(calls).not.toContain(`check ${ORIGIN}`);
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

  it("is refused when a controller URL is saved", async () => {
    saveControllerUrl();
    expect(await run(start)).toEqual(new ControllerAlreadySaved());
    expect(calls).toEqual([]);
  });
});

describe("LocalController.find and LocalController.start", () => {
  it("run one at a time, so a find while Hercule starts waits, then finds the URL saved", async () => {
    const outcomes = await run((service) =>
      Effect.gen(function* () {
        const statusRead = yield* Deferred.make<void>();
        const statusAnswered = yield* Deferred.make<void>();
        fakes.status = Deferred.succeed(statusRead, undefined).pipe(
          Effect.andThen(Deferred.await(statusAnswered)),
          Effect.as(FRESH_REPORT),
        );
        const started = yield* Effect.forkChild(service.start);
        yield* Deferred.await(statusRead);
        const found = yield* Effect.forkChild(Effect.flip(service.find));
        yield* Effect.yieldNow;
        // The find waits for the start, so it has not read the status yet.
        expect(calls).toEqual(["status"]);
        yield* Deferred.succeed(statusAnswered, undefined);
        return [yield* Fiber.join(started), yield* Fiber.join(found)];
      }),
    );
    expect(outcomes).toEqual([{ _tag: "Saved", origin: ORIGIN }, new ControllerAlreadySaved()]);
    expect(calls.filter((call) => call.startsWith("save"))).toEqual([`save ${ORIGIN}`]);
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

  it("opens the logs folder the install reported", async () => {
    fakes.install = Effect.succeed({ ...CONTROLLER_REPORT, logsDir: "/Users/ada/other/logs" });
    await run((service) => Effect.andThen(service.start, service.showLogsFolder));
    expect(calls.at(-1)).toBe("openFolder /Users/ada/other/logs");
  });
});
