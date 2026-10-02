/**
 * The refusals `installService` and `prepareServiceInstall` run before they
 * ask the Supervisor, against a fake Supervisor that records what it was asked.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { installService, prepareServiceInstall, type ServiceInstallRequest } from "./install";
import { ServiceError, Supervisor, type ServiceStatus } from "./supervisor";
import { expectSuccess, readFailureMessage } from "./testing";
import type { ServiceUnit } from "./unit";

let scratch: string;
let program: string;
let asked: Array<string>;
let preparedUnits: Array<ServiceUnit>;

const STATUS: ServiceStatus = {
  installed: true,
  running: true,
  pid: 42,
  role: "runner",
  home: "/h",
  unitFile: "/u",
};

const unused = Effect.die(new Error("The test did not expect this verb."));

const buildFakeSupervisor = (prepare: Effect.Effect<void, ServiceError> = Effect.void) =>
  Layer.succeed(
    Supervisor,
    Supervisor.of({
      uninstallNote: undefined,
      prepare: (unit) =>
        Effect.suspend(() => {
          asked.push("prepare");
          preparedUnits.push(unit);
          return prepare;
        }),
      install: () =>
        Effect.sync(() => {
          asked.push("install");
          return STATUS;
        }),
      uninstall: unused,
      start: unused,
      stop: unused,
      restart: unused,
      readStatus: unused,
    }),
  );

const buildRequest = (changes: Partial<ServiceInstallRequest> = {}): ServiceInstallRequest => ({
  role: "runner",
  home: join(scratch, "home"),
  overrides: [],
  env: { PATH: "/usr/bin" },
  program,
  ...changes,
});

const runPrepare = (request: ServiceInstallRequest, supervisor = buildFakeSupervisor()) =>
  Effect.runPromise(Effect.result(Effect.provide(prepareServiceInstall(request), supervisor)));

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hercule-service-install-"));
  mkdirSync(join(scratch, "bin"));
  program = join(scratch, "bin", "hercule");
  writeFileSync(program, "");
  chmodSync(program, 0o755);
  asked = [];
  preparedUnits = [];
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("prepareServiceInstall", () => {
  it("asks the Supervisor to prepare the unit it would install, and installs nothing", async () => {
    expectSuccess(await runPrepare(buildRequest()));
    expect(asked).toEqual(["prepare"]);
    expect(preparedUnits).toEqual([
      {
        role: "runner",
        program,
        home: join(scratch, "home"),
        path: "/usr/bin",
        stderrLog: join(scratch, "home", "logs", "runner.stderr.log"),
      },
    ]);
  });

  it("fails with the Supervisor's refusal", async () => {
    const refusing = buildFakeSupervisor(
      Effect.fail(new ServiceError({ message: "Another Home is installed." })),
    );
    expect(readFailureMessage(await runPrepare(buildRequest(), refusing))).toBe(
      "Another Home is installed.",
    );
  });
});

describe("the refusals before the Supervisor", () => {
  it("refuses a binary every user can write to", async () => {
    chmodSync(program, 0o777);
    expect(readFailureMessage(await runPrepare(buildRequest()))).toBe(
      `Every user on this machine can write to ${program}, so anyone could change the program the service runs. Run \`chmod o-w ${program}\`, then run this again.`,
    );
    expect(asked).toEqual([]);
  });

  it("refuses a binary in a folder every user can write to", async () => {
    const folder = join(scratch, "bin");
    chmodSync(folder, 0o777);
    expect(readFailureMessage(await runPrepare(buildRequest()))).toBe(
      `Every user on this machine can write to ${folder}, so anyone could change the program the service runs. Run \`chmod o-w ${folder}\`, then run this again.`,
    );
    expect(asked).toEqual([]);
  });

  it("refuses a binary with a control character in its path", async () => {
    const odd = join(scratch, "bin\nExecStartPre=/bin/sh", "hercule");
    expect(readFailureMessage(await runPrepare(buildRequest({ program: odd })))).toBe(
      `The binary ${JSON.stringify(odd)} has a control character, which a unit file cannot hold. Use a path without one.`,
    );
    expect(asked).toEqual([]);
  });

  it("refuses a PATH folder with a control character", async () => {
    const odd = join(scratch, "tools\tbin");
    mkdirSync(odd);
    const message = readFailureMessage(
      await runPrepare(buildRequest({ env: { PATH: `/usr/bin:${odd}` } })),
    );
    expect(message).toBe(
      `The PATH ${JSON.stringify(`/usr/bin:${odd}`)} has a control character, which a unit file cannot hold. Use a path without one.`,
    );
    expect(asked).toEqual([]);
  });
});

describe("installService", () => {
  it("runs the same refusals before it installs", async () => {
    chmodSync(program, 0o777);
    const result = await Effect.runPromise(
      Effect.result(Effect.provide(installService(buildRequest()), buildFakeSupervisor())),
    );
    expect(readFailureMessage(result)).toContain("Every user on this machine can write to");
    expect(asked).toEqual([]);
  });

  it("returns the Supervisor's status once it installed the unit", async () => {
    const result = await Effect.runPromise(
      Effect.result(Effect.provide(installService(buildRequest()), buildFakeSupervisor())),
    );
    expect(expectSuccess(result)).toEqual(STATUS);
    expect(asked).toEqual(["install"]);
  });
});
