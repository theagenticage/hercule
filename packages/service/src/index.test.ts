/**
 * `runServiceCommand` against a fake Supervisor: the command line, the
 * refusals before anything reaches the Supervisor, and what each verb prints.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { locateRunnerDir } from "@hercule/home";
import { describeStatus, runServiceCommand, type ServiceCommandRequest } from "./index";
import { Supervisor, type ServiceStatus } from "./supervisor";
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
    unitFile: UNIT_FILE,
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
    writeFileSync(join(locateRunnerDir(home), "runner.json"), "{}");
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

  it.each(["install", "status"])(
    "refuses a -c flag on %s, which the unit would not see",
    async (verb) => {
      expect(await run([verb], { overrides: [["bind.port", "5000"]] })).toBe(2);
      expect(err).toEqual([
        `hercule: -c bind.port=5000 does not reach the service, which reads only ${join(home, "config.toml")}. Put bind.port in that file instead.`,
        "run `hercule service --help`",
      ]);
      expect(actions).toEqual([]);
    },
  );

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
