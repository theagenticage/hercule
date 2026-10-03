/**
 * `runServiceCommand` against a fake Supervisor: the help, the command line,
 * the refusals before anything reaches the Supervisor, and what each verb
 * prints.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { locateRunnerDir, locateRunnerFile } from "@hercule/home";
import {
  describeStatus,
  runServiceCommand,
  SERVICE_VERBS,
  type ServiceCommandDependencies,
  type ServiceCommandRequest,
} from "./command";
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
    prepare: () =>
      Effect.sync(() => {
        actions.push("prepare");
      }),
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
  dependencies: Partial<ServiceCommandDependencies> = {},
): Promise<number> =>
  runServiceCommand(
    {
      args,
      homeOption: home,
      overrides: [],
      env: { PATH: "/usr/bin" },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      ...request,
    },
    { supervisor: FakeSupervisor, program: PROGRAM, ...dependencies },
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
  it("prints the help with one line per verb", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(out[0]).toBe("usage: hercule service <verb> [--json]");
    for (const verb of SERVICE_VERBS) {
      expect(
        out.filter((line) => new RegExp(`^  ${verb}\\s`).test(line)),
        `${verb} has one line`,
      ).toHaveLength(1);
    }
    expect(err).toEqual([]);
  });

  it("prints the same help after a verb, and with -h", async () => {
    await run(["--help"]);
    const help = out;
    out = [];
    expect(await run(["install", "--help"])).toBe(0);
    expect(out).toEqual(help);
    out = [];
    expect(await run(["-h"])).toBe(0);
    expect(out).toEqual(help);
    expect(actions).toEqual([]);
  });

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
    expect(err).toEqual([
      "hercule: service install takes no `--force`",
      "run `hercule service --help`",
    ]);
    expect(actions).toEqual([]);
  });

  it("inside a session, prints the help but refuses a verb when no Home is named", async () => {
    // The status verb is used because it is harmless if the refusal ever breaks:
    // the Supervisor here is a fake, and status writes nothing.
    const inSession = { homeOption: undefined, env: { PATH: "/usr/bin", HERCULE_SESSION: "1" } };

    expect(await run(["--help"], inSession)).toBe(0);
    expect(await run(["status"], inSession)).toBe(2);
    // One line, with no pointer to the help, which cannot name the missing Home.
    expect(err).toHaveLength(1);
    expect(err[0]).toMatch(/^hercule: --home: this command runs inside a Hercule session/);
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
        path: "/usr/bin",
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
      controllerUrl: "http://127.0.0.1:4937",
      logsDir: join(home, "logs"),
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
    expect(await run(["install"], { homeOption: odd })).toBe(1);
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
        prepare: () => Effect.fail(new ServiceError({ message: "launchd said no." })),
        install: () => Effect.fail(new ServiceError({ message: "launchd said no." })),
        uninstall: Effect.fail(new ServiceError({ message: "launchd said no." })),
        start: Effect.fail(new ServiceError({ message: "launchd said no." })),
        stop: Effect.fail(new ServiceError({ message: "launchd said no." })),
        restart: Effect.fail(new ServiceError({ message: "launchd said no." })),
        readStatus: Effect.fail(new ServiceError({ message: "launchd said no." })),
      }),
    );
    expect(await run(["start"], {}, { supervisor: failing })).toBe(1);
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

  it("refuses a config.toml it cannot parse, before reaching the Supervisor", async () => {
    // The unit's process would stop at the same error at every start.
    writeFileSync(join(home, "config.toml"), "[data\n");
    expect(await run(["install", "--json"])).toBe(1);
    expect(err).toEqual([
      expect.stringMatching(new RegExp(`^hercule: ${join(home, "config.toml")} `)),
    ]);
    expect(out).toEqual([]);
    expect(actions).toEqual([]);
  });

  it("refuses a config.toml with a value Hercule cannot use", async () => {
    writeFileSync(join(home, "config.toml"), 'bind.host = "http://example.com"\n');
    expect(await run(["install"])).toBe(1);
    expect(err[0]).toMatch(new RegExp(`^hercule: bind.host in ${join(home, "config.toml")} `));
    expect(actions).toEqual([]);
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

describe("a verb that acts on the unit, inside a session", () => {
  const SESSION_ENV = { PATH: "/usr/bin", HERCULE_SESSION: "1" };
  const ACTING_VERBS = ["start", "stop", "restart", "uninstall"] as const;

  /** Installs the fake unit for the Hercule Home `unitHome`. */
  const installUnitFor = (unitHome: string | null): void => {
    installed = {
      installed: true,
      running: true,
      pid: 42,
      role: "serve",
      home: unitHome,
      unitFile: UNIT_FILE,
    };
  };

  it.each(ACTING_VERBS)(
    "refuses %s when the unit runs another Home, and leaves the unit alone",
    async (verb) => {
      installUnitFor("/live");

      expect(await run([verb], { homeOption: home, env: SESSION_ENV })).toBe(1);
      expect(actions).toEqual([]);
      expect(err).toEqual([
        `hercule: The Hercule service on this machine runs the Hercule Home /live, not ${home}. Inside a session, \`hercule service ${verb}\` may only act on the service of the Home it names, because the other one may be the user's live Hercule. Run it outside the session.`,
      ]);
    },
  );

  it.each(ACTING_VERBS)("refuses %s when the unit names no Home", async (verb) => {
    installUnitFor(null);

    expect(await run([verb], { homeOption: home, env: SESSION_ENV })).toBe(1);
    expect(actions).toEqual([]);
    expect(err[0]).toContain("runs a Hercule Home its unit file does not name");
  });

  it.each(ACTING_VERBS)("runs %s when the unit runs the Home it names", async (verb) => {
    installUnitFor(home);

    expect(await run([verb], { homeOption: home, env: SESSION_ENV })).toBe(0);
    expect(actions).toEqual([verb]);
    expect(err).toEqual([]);
  });

  it.each(ACTING_VERBS)("runs %s when no unit is installed", async (verb) => {
    expect(await run([verb], { homeOption: home, env: SESSION_ENV })).toBe(0);
    expect(actions).toEqual([verb]);
  });

  it.each(ACTING_VERBS)("runs %s on another Home's unit outside a session", async (verb) => {
    installUnitFor("/live");

    expect(await run([verb], { homeOption: home })).toBe(0);
    expect(actions).toEqual([verb]);
  });

  it("still reports the status of another Home's unit", async () => {
    installUnitFor("/live");

    expect(await run(["status"], { homeOption: home, env: SESSION_ENV })).toBe(0);
    expect(out).toEqual([
      "The Hercule service runs `hercule serve` for the Hercule Home /live, as pid 42.",
    ]);
  });
});

describe("the --json report", () => {
  /** Runs a verb with `--json`, checks that it succeeded, and returns the parsed JSON. */
  const runForReport = async (
    verb: string,
    request: Partial<ServiceCommandRequest> = {},
  ): Promise<Record<string, unknown>> => {
    expect(await run([verb, "--json"], request)).toBe(0);
    return JSON.parse(out.join("\n")) as Record<string, unknown>;
  };

  // The desktop app reads these fields without importing this package, so a
  // rename must fail here first, and be made in spec 15 section 4 too.
  it.each(SERVICE_VERBS)("%s prints exactly the fields spec 15 section 4 lists", async (verb) => {
    const report = await runForReport(verb);
    expect(Object.keys(report).sort()).toEqual([
      "controllerUrl",
      "home",
      "installed",
      "logsDir",
      "pid",
      "role",
      "running",
      "unitFile",
    ]);
  });

  it("describes the installed unit's Home, even when this command ran for another", async () => {
    const unitHome = mkdtempSync(join(tmpdir(), "hercule-service-unit-home-"));
    try {
      writeFileSync(join(unitHome, "config.toml"), "bind.port = 5050\n");
      installed = {
        installed: true,
        running: true,
        pid: 42,
        role: "serve",
        home: unitHome,
        unitFile: UNIT_FILE,
      };
      const report = await runForReport("status");
      expect(report.home).toBe(unitHome);
      expect(report.logsDir).toBe(join(unitHome, "logs"));
      expect(report.controllerUrl).toBe("http://127.0.0.1:5050");
    } finally {
      rmSync(unitHome, { recursive: true, force: true });
    }
  });

  it("describes this command's Home when no unit is installed", async () => {
    writeFileSync(join(home, "config.toml"), "bind.port = 6060\n");
    const report = await runForReport("status");
    expect(report.home).toBeNull();
    expect(report.logsDir).toBe(join(home, "logs"));
    expect(report.controllerUrl).toBe("http://127.0.0.1:6060");
  });

  it("describes this command's Home when the installed unit names no Home", async () => {
    installed = {
      installed: true,
      running: false,
      pid: null,
      role: null,
      home: null,
      unitFile: UNIT_FILE,
    };
    const report = await runForReport("status");
    expect(report.logsDir).toBe(join(home, "logs"));
    expect(report.controllerUrl).toBe("http://127.0.0.1:4937");
  });

  it("builds controllerUrl from config.toml, and turns a wildcard host into loopback", async () => {
    writeFileSync(join(home, "config.toml"), 'bind.host = "0.0.0.0"\nbind.port = 8080\n');
    expect((await runForReport("status")).controllerUrl).toBe("http://127.0.0.1:8080");
  });

  it("ignores HERCULE_* variables, which the unit does not see", async () => {
    const report = await runForReport("status", {
      env: { HERCULE_BIND_HOST: "100.64.0.1", HERCULE_BIND_PORT: "5000" },
    });
    expect(report.controllerUrl).toBe("http://127.0.0.1:4937");
  });

  it("prints a null controllerUrl when config.toml cannot be read", async () => {
    writeFileSync(join(home, "config.toml"), "[data\n");
    const report = await runForReport("status");
    expect(report.controllerUrl).toBeNull();
    expect(report.logsDir).toBe(join(home, "logs"));
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
