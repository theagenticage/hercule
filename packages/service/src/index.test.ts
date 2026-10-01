/**
 * `runServiceCommand` against a fake Supervisor: the command line, the
 * refusals before anything reaches the Supervisor, and what each verb prints.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, Result } from "effect";
import { locateRunnerDir, locateRunnerFile } from "@hercule/home";
import {
  checkServiceCanBeInstalled,
  describeStatus,
  runServiceCommand,
  type ServiceCommandRequest,
} from "./index";
import { ServiceError, Supervisor, type ServiceStatus } from "./supervisor";
import type { ServiceUnit } from "./unit";

const UNIT_FILE = "/Users/ada/Library/LaunchAgents/sh.hercule.service.plist";
const PROGRAM = "/Users/ada/.local/bin/hercule";

let home: string;
let installed: ServiceStatus;
let actions: Array<string>;
let installedUnits: Array<ServiceUnit>;
let out: Array<string>;
let err: Array<string>;

const NOT_INSTALLED: Omit<ServiceStatus, "unitFile"> = {
  installed: false,
  running: false,
  pid: null,
  role: null,
  home: null,
};

const FakeSupervisor = Layer.sync(Supervisor, () =>
  Supervisor.of({
    uninstallNote: "A note about what uninstall leaves.",
    install: (unit) =>
      Effect.sync(() => {
        actions.push("install");
        installedUnits.push(unit);
        installed = {
          installed: true,
          running: true,
          pid: 42,
          role: unit.role,
          home: unit.home,
          unitFile: UNIT_FILE,
        };
        return installed;
      }),
    uninstall: Effect.sync(() => {
      actions.push("uninstall");
      installed = { ...NOT_INSTALLED, unitFile: UNIT_FILE };
      return installed;
    }),
    start: Effect.sync(() => {
      actions.push("start");
      return installed;
    }),
    stop: Effect.sync(() => {
      actions.push("stop");
      return installed;
    }),
    restart: Effect.sync(() => {
      actions.push("restart");
      return installed;
    }),
    readStatus: Effect.sync(() => installed),
  }),
);

const run = (
  args: ReadonlyArray<string>,
  request: Partial<ServiceCommandRequest> = {},
  dependencies: { readonly program: string | undefined } = { program: PROGRAM },
): Promise<number> =>
  runServiceCommand(
    {
      args,
      home,
      overrides: [],
      env: { PATH: "/usr/bin" },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...request,
    },
    { supervisor: FakeSupervisor, program: dependencies.program },
  );

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-service-command-"));
  installed = { ...NOT_INSTALLED, unitFile: UNIT_FILE };
  actions = [];
  installedUnits = [];
  out = [];
  err = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the command line", () => {
  it("exits 2 and names the verbs when there is no verb", async () => {
    expect(await run([])).toBe(2);
    expect(err).toEqual([
      "hercule: service needs a verb: install, uninstall, start, stop, restart, status",
      "run `hercule service --help`",
    ]);
    expect(actions).toEqual([]);
  });

  it("exits 2 on an unknown verb", async () => {
    expect(await run(["reload"])).toBe(2);
    expect(err[0]).toBe(
      "hercule: unknown command `reload`; the service verbs are install, uninstall, start, stop, restart, status",
    );
  });

  it("exits 2 on a flag other than --json, before reaching the Supervisor", async () => {
    expect(await run(["install", "--force"])).toBe(2);
    expect(err[0]).toBe("hercule: service install takes no `--force`");
    expect(actions).toEqual([]);
  });
});

describe("install", () => {
  it("says which role it installs and why, then prints the status", async () => {
    mkdirSync(locateRunnerDir(home), { recursive: true });
    writeFileSync(locateRunnerFile(home), "{}");
    expect(await run(["install"])).toBe(0);
    expect(out).toEqual([
      "Installing the unit for `hercule runner`: this Home holds a runner.json and no controller database.",
      `The Hercule service runs \`hercule runner\` for the Hercule Home ${home}, as pid 42.`,
    ]);
    expect(installedUnits).toEqual([
      {
        role: "runner",
        program: PROGRAM,
        home,
        path: "/Users/ada/.local/bin:/usr/bin",
        stderrLog: join(home, "logs", "runner.stderr.log"),
      },
    ]);
  });

  it("prints only the status JSON on stdout with --json", async () => {
    expect(await run(["install", "--json"])).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual({
      installed: true,
      running: true,
      pid: 42,
      role: "serve",
      home,
      unitFile: UNIT_FILE,
    });
    expect(err).toEqual([
      "Installing the unit for `hercule serve`: this Home holds no runner.json.",
    ]);
  });

  it("refuses to install from a source checkout", async () => {
    expect(await run(["install"], {}, { program: undefined })).toBe(1);
    expect(err).toEqual([
      "hercule: A service runs the compiled hercule binary, and this Hercule runs from a source checkout. Build the binary with `pnpm build:binary` and run `./hercule service install`.",
    ]);
    // The role line comes first on purpose: it says what install was about to do.
    expect(out).toEqual([
      "Installing the unit for `hercule serve`: this Home holds no runner.json.",
    ]);
    expect(actions).toEqual([]);
  });

  it.each(["install", "restart", "status"])(
    "refuses a -c flag on %s, which the unit would not see",
    async (verb) => {
      expect(await run([verb], { overrides: [["bind.port", "5000"]] })).toBe(1);
      expect(err).toEqual([
        `hercule: -c bind.port=5000 applies only to this command, and the service reads only ${join(home, "config.toml")}. Put bind.port in that file instead, then run this again without -c.`,
      ]);
      expect(actions).toEqual([]);
    },
  );

  it("refuses a PATH folder every user can write to", async () => {
    const shared = join(home, "shared-bin");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    expect(await run(["install"], { env: { PATH: `/usr/bin:${shared}` } })).toBe(1);
    expect(err).toEqual([
      `hercule: ${shared} is on the PATH the service runs with, and every user on this machine can write to it, so anyone could put a program there that the service runs. Remove ${shared} from PATH, or run \`chmod o-w ${shared}\`, then run this again.`,
    ]);
    expect(actions).toEqual([]);
  });

  it("refuses a Hercule Home with a line break in its path", async () => {
    const odd = join(home, "odd\nExecStartPre=/bin/sh");
    mkdirSync(odd, { recursive: true });
    expect(await run(["install"], { home: odd })).toBe(1);
    expect(err).toEqual([
      `hercule: The Hercule Home ${JSON.stringify(odd)} has a control character, which a unit file cannot hold. Use a path without one.`,
    ]);
    expect(actions).toEqual([]);
  });

  it("exits 1 with the Supervisor's message when the verb fails", async () => {
    const failing = Layer.succeed(
      Supervisor,
      Supervisor.of({
        uninstallNote: undefined,
        install: () => Effect.fail(new ServiceError({ message: "launchd said no." })),
        uninstall: Effect.fail(new ServiceError({ message: "launchd said no." })),
        start: Effect.fail(new ServiceError({ message: "launchd said no." })),
        stop: Effect.fail(new ServiceError({ message: "launchd said no." })),
        restart: Effect.fail(new ServiceError({ message: "launchd said no." })),
        readStatus: Effect.fail(new ServiceError({ message: "launchd said no." })),
      }),
    );
    const code = await runServiceCommand(
      {
        args: ["start"],
        home,
        overrides: [],
        env: {},
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
      { supervisor: failing, program: PROGRAM },
    );
    expect(code).toBe(1);
    expect(err).toEqual(["hercule: launchd said no."]);
    expect(out).toEqual([]);
  });

  it("refuses a HERCULE_* bootstrap variable, and honours HERCULE_HOME", async () => {
    expect(
      await run(["install"], { env: { HERCULE_HOME: home, HERCULE_LOG_LEVEL: "debug" } }),
    ).toBe(1);
    expect(err).toEqual([
      `hercule: HERCULE_LOG_LEVEL is set, and the service reads only ${join(home, "config.toml")}. Put log.level in that file instead, then unset HERCULE_LOG_LEVEL and run this again.`,
    ]);
    expect(actions).toEqual([]);
  });

  it("prints the path of a config.toml it cannot parse", async () => {
    writeFileSync(join(home, "config.toml"), "[data\n");
    expect(await run(["install"])).toBe(1);
    expect(err[0]).toMatch(new RegExp(`^hercule: ${join(home, "config.toml")} `));
  });
});

describe("checkServiceCanBeInstalled", () => {
  it("refuses a runner unit for a Home that holds a controller database", async () => {
    mkdirSync(join(home, "data"));
    writeFileSync(join(home, "data", "hercule.db"), "");
    const result = await Effect.runPromise(
      Effect.result(
        checkServiceCanBeInstalled({
          role: "runner",
          home,
          overrides: [],
          env: { PATH: "/usr/bin" },
          program: PROGRAM,
        }),
      ),
    );
    expect(Result.isFailure(result) && result.failure.message).toBe(
      `The Hercule Home ${home} holds a controller database, so its service runs \`hercule serve\`, which starts a runner of its own. To make this machine a separate runner, give it its own Home with --home.`,
    );
  });
});

describe("uninstall", () => {
  it("says what it deleted, what stays, and the Supervisor's note", async () => {
    installed = {
      installed: true,
      running: true,
      pid: 42,
      role: "serve",
      home,
      unitFile: UNIT_FILE,
    };
    expect(await run(["uninstall"])).toBe(0);
    expect(out).toEqual([
      `Uninstalled the Hercule service and deleted ${UNIT_FILE}.`,
      `The logs in ${join(home, "logs")} stay.`,
      "A note about what uninstall leaves.",
    ]);
  });

  it("says there was nothing to uninstall", async () => {
    expect(await run(["uninstall"])).toBe(0);
    expect(out).toEqual([
      "No Hercule service is installed on this machine, so there is nothing to uninstall.",
    ]);
    expect(actions).toEqual(["uninstall"]);
  });
});

describe("the other verbs", () => {
  it.each(["start", "stop", "restart"])(
    "%s runs the Supervisor's verb and prints the status",
    async (verb) => {
      installed = {
        installed: true,
        running: false,
        pid: null,
        role: "serve",
        home,
        unitFile: UNIT_FILE,
      };
      expect(await run([verb])).toBe(0);
      expect(actions).toEqual([verb]);
      expect(out).toEqual([
        `The Hercule service is installed to run \`hercule serve\` for the Hercule Home ${home}, and is not running.`,
      ]);
    },
  );

  it("status prints the status", async () => {
    expect(await run(["status"])).toBe(0);
    expect(out).toEqual(["No Hercule service is installed on this machine."]);
  });
});

describe("describeStatus", () => {
  it("names Hercule when the unit names no role or Home", () => {
    expect(
      describeStatus({
        installed: true,
        running: true,
        pid: 7,
        role: null,
        home: null,
        unitFile: UNIT_FILE,
      }),
    ).toBe("The Hercule service runs Hercule, as pid 7.");
  });
});
