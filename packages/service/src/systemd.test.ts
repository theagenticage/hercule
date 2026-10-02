/**
 * The systemd Supervisor against a fake `systemctl --user` and `loginctl`: a
 * small model of the user's service manager. The tests check the commands each
 * verb runs, in order, and what it reports.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { RunCommand } from "./supervisor";
import { createSystemdSupervisor, locateSystemdUnitDir, parseSystemdPid } from "./systemd";
import { buildCommandResult, expectSuccess, readFailureMessage, runOnTestClock } from "./testing";
import { renderSystemdUnit, type ServiceUnit } from "./unit";

const SHOW = "systemctl --user show hercule.service -p MainPID";

/** What the fake service manager holds, and how it behaves. Tests change it to set up a case. */
interface SystemdState {
  linger: boolean;
  /** `loginctl enable-linger` fails, as it does without the right to change another user's settings. */
  lingerRefused: boolean;
  pid: number | null;
  /** The process never starts. */
  neverStarts: boolean;
  /** The process exits at boot, so systemd starts it again under a new pid on every look. */
  crashLoop: boolean;
}

let scratch: string;
let unitDir: string;
let home: string;
let unitFile: string;
let state: SystemdState;
let calls: Array<string>;
let nextPid: number;

const startProcess = (): void => {
  state.pid = state.neverStarts ? null : nextPid++;
};

const fakeRun: RunCommand = (argv) =>
  Effect.sync(() => {
    calls.push(argv.join(" "));
    if (argv[0] === "loginctl") {
      if (argv[1] === "show-user")
        return buildCommandResult(0, `Linger=${state.linger ? "yes" : "no"}\n`);
      if (state.lingerRefused)
        return buildCommandResult(1, "", "Could not enable linger: Access denied");
      state.linger = true;
      return buildCommandResult(0);
    }
    if (argv[0] !== "systemctl" || argv[1] !== "--user") return buildCommandResult(127);
    switch (argv[2]) {
      case "show": {
        if (state.crashLoop && state.pid !== null) startProcess();
        return buildCommandResult(0, `MainPID=${state.pid ?? 0}\n`);
      }
      case "start":
        if (state.pid === null) startProcess();
        return buildCommandResult(0);
      case "restart":
        startProcess();
        return buildCommandResult(0);
      case "stop":
      case "disable":
        state.pid = null;
        return buildCommandResult(0);
      default:
        return buildCommandResult(0);
    }
  });

const supervisor = () =>
  createSystemdSupervisor({ run: fakeRun, unitDir, uid: 1000, userName: "ada" });

const buildUnit = (overrides: Partial<ServiceUnit> = {}): ServiceUnit => ({
  role: "runner",
  program: "/home/ada/.local/bin/hercule",
  home,
  path: "/home/ada/.local/bin:/usr/bin",
  stderrLog: join(home, "logs", "runner.stderr.log"),
  ...overrides,
});

/** Writes a unit and runs its process in the fake, as a previous install would have. */
const installBefore = (unit: ServiceUnit, pid: number | null = 100): void => {
  writeFileSync(unitFile, renderSystemdUnit(unit));
  state.pid = pid;
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hercule-systemd-"));
  unitDir = join(scratch, "systemd", "user");
  home = join(scratch, "home");
  unitFile = join(unitDir, "hercule.service");
  mkdirSync(unitDir, { recursive: true });
  state = { linger: true, lingerRefused: false, pid: null, neverStarts: false, crashLoop: false };
  calls = [];
  nextPid = 200;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("parseSystemdPid", () => {
  it("reads MainPID, and returns null for 0 or no MainPID line", () => {
    expect(parseSystemdPid("MainPID=4242\n")).toBe(4242);
    expect(parseSystemdPid("MainPID=0\n")).toBeNull();
    expect(parseSystemdPid("")).toBeNull();
  });
});

describe("install", () => {
  it("writes the unit, enables it, restarts it, and waits for the process to keep its pid", async () => {
    const { result, seconds } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(expectSuccess(result)).toEqual({
      installed: true,
      running: true,
      pid: 200,
      role: "runner",
      home,
      unitFile,
    });
    expect(calls).toEqual([
      "loginctl show-user 1000 -p Linger",
      SHOW,
      "systemctl --user daemon-reload",
      "systemctl --user enable hercule.service",
      "systemctl --user restart hercule.service",
      SHOW,
      SHOW,
      SHOW,
    ]);
    expect(seconds).toBe(3);
    expect(readFileSync(unitFile, "utf8")).toBe(renderSystemdUnit(buildUnit()));
    expect(statSync(unitFile).mode & 0o777).toBe(0o644);
    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
  });

  it("turns lingering on first when it is off", async () => {
    state.linger = false;
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(expectSuccess(result).running).toBe(true);
    expect(calls.slice(0, 3)).toEqual([
      "loginctl show-user 1000 -p Linger",
      "loginctl enable-linger 1000",
      SHOW,
    ]);
  });

  it("writes nothing and starts nothing when lingering cannot be turned on", async () => {
    state.linger = false;
    state.lingerRefused = true;
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toBe(
      "Could not turn on lingering for ada, so systemd would stop Hercule when ada logs out. Run `sudo loginctl enable-linger ada`, then run this again.",
    );
    expect(calls).toEqual(["loginctl show-user 1000 -p Linger", "loginctl enable-linger 1000"]);
    expect(existsSync(unitFile)).toBe(false);
    expect(existsSync(join(home, "logs"))).toBe(false);
  });

  it("names the user by uid in the command when the user name is unknown", async () => {
    state.linger = false;
    state.lingerRefused = true;
    const { result } = await runOnTestClock(
      createSystemdSupervisor({ run: fakeRun, unitDir, uid: 1000, userName: undefined }).install(
        buildUnit(),
      ),
    );
    expect(readFailureMessage(result)).toBe(
      "Could not turn on lingering for this user, so systemd would stop Hercule when this user logs out. Run `sudo loginctl enable-linger 1000`, then run this again.",
    );
  });

  it("restarts a running unit and waits for the new pid", async () => {
    installBefore(buildUnit(), 100);
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(expectSuccess(result).pid).toBe(200);
  });

  it("refuses when the installed unit runs another Home, and changes nothing", async () => {
    const other = buildUnit({ home: "/home/ada/other-home" });
    installBefore(other);
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toBe(
      "The Hercule service on this machine runs the Hercule Home /home/ada/other-home, and there is one unit per machine. To keep it, run this with --home /home/ada/other-home; to replace it, run `hercule service uninstall` first.",
    );
    expect(calls).toEqual([]);
    expect(readFileSync(unitFile, "utf8")).toBe(renderSystemdUnit(other));
  });

  it("fails after 30 seconds, pointing at the runner's logs, when no process starts", async () => {
    state.neverStarts = true;
    const { result, seconds } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toBe(
      `The Hercule service did not start within 30 seconds. See ${home}/logs/runner.log and ${home}/logs/runner.stderr.log for the reason.`,
    );
    expect(seconds).toBe(30);
  });

  it("fails when the process does not keep its pid for three seconds", async () => {
    state.crashLoop = true;
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toContain("stopped right after it started");
  });

  it("fails with systemd's own words when a command fails", async () => {
    const failing: RunCommand = (argv) =>
      argv.includes("enable")
        ? Effect.succeed(buildCommandResult(1, "", "Failed to enable unit: Unit file is masked.\n"))
        : fakeRun(argv);
    const { result } = await runOnTestClock(
      createSystemdSupervisor({ run: failing, unitDir, uid: 1000, userName: "ada" }).install(
        buildUnit(),
      ),
    );
    expect(readFailureMessage(result)).toBe(
      "systemd did not enable the Hercule service: `systemctl --user enable hercule.service` exited with 1: Failed to enable unit: Unit file is masked.",
    );
  });
});

describe("prepare", () => {
  it("turns lingering on, and writes and starts nothing", async () => {
    state.linger = false;
    expectSuccess(await Effect.runPromise(Effect.result(supervisor().prepare(buildUnit()))));
    expect(calls).toEqual(["loginctl show-user 1000 -p Linger", "loginctl enable-linger 1000"]);
    expect(state.linger).toBe(true);
    expect(existsSync(unitFile)).toBe(false);
    expect(existsSync(join(home, "logs"))).toBe(false);
  });

  it("refuses when the installed unit runs another Home, before it turns lingering on", async () => {
    state.linger = false;
    installBefore(buildUnit({ home: "/home/ada/other-home" }));
    const result = await Effect.runPromise(Effect.result(supervisor().prepare(buildUnit())));
    expect(readFailureMessage(result)).toContain("runs the Hercule Home /home/ada/other-home");
    expect(calls).toEqual([]);
    expect(state.linger).toBe(false);
  });
});

describe("locateSystemdUnitDir", () => {
  it("uses an absolute XDG_CONFIG_HOME", () => {
    expect(locateSystemdUnitDir({ XDG_CONFIG_HOME: "/etc/ada" }, "/home/ada")).toBe(
      "/etc/ada/systemd/user",
    );
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset or relative, as systemd does", () => {
    expect(locateSystemdUnitDir({}, "/home/ada")).toBe("/home/ada/.config/systemd/user");
    expect(locateSystemdUnitDir({ XDG_CONFIG_HOME: "config" }, "/home/ada")).toBe(
      "/home/ada/.config/systemd/user",
    );
  });
});

describe("start", () => {
  it("fails with the exact message when no unit is installed, and runs nothing", async () => {
    const { result } = await runOnTestClock(supervisor().start);
    expect(readFailureMessage(result)).toBe(
      "No Hercule service is installed on this machine. Run `hercule service install`.",
    );
    expect(calls).toEqual([]);
  });

  it("starts a stopped unit and waits for its process", async () => {
    installBefore(buildUnit(), null);
    const { result } = await runOnTestClock(supervisor().start);
    expect(expectSuccess(result).pid).toBe(200);
    expect(calls).toEqual([SHOW, "systemctl --user start hercule.service", SHOW, SHOW, SHOW]);
  });

  it("does nothing to a running process", async () => {
    installBefore(buildUnit(), 100);
    const { result, seconds } = await runOnTestClock(supervisor().start);
    expect(expectSuccess(result).pid).toBe(100);
    expect(calls).toEqual([SHOW, SHOW]);
    expect(seconds).toBe(0);
  });
});

describe("stop", () => {
  it("stops the process and keeps the unit", async () => {
    installBefore(buildUnit(), 100);
    const { result } = await runOnTestClock(supervisor().stop);
    expect(expectSuccess(result)).toMatchObject({ installed: true, running: false, pid: null });
    expect(calls).toEqual(["systemctl --user stop hercule.service", SHOW]);
  });

  it("fails when no unit is installed", async () => {
    const { result } = await runOnTestClock(supervisor().stop);
    expect(readFailureMessage(result)).toContain("No Hercule service is installed");
  });
});

describe("restart", () => {
  it("restarts the process and waits for the new pid", async () => {
    installBefore(buildUnit(), 100);
    const { result } = await runOnTestClock(supervisor().restart);
    expect(expectSuccess(result).pid).toBe(200);
    expect(calls).toEqual([SHOW, "systemctl --user restart hercule.service", SHOW, SHOW, SHOW]);
  });

  it("fails when no unit is installed", async () => {
    const { result } = await runOnTestClock(supervisor().restart);
    expect(readFailureMessage(result)).toContain("No Hercule service is installed");
  });
});

describe("uninstall", () => {
  it("disables and stops the unit, deletes it, and reloads systemd", async () => {
    installBefore(buildUnit(), 100);
    const { result } = await runOnTestClock(supervisor().uninstall);
    expect(expectSuccess(result)).toEqual({
      installed: false,
      running: false,
      pid: null,
      role: null,
      home: null,
      unitFile,
    });
    expect(calls).toEqual([
      "systemctl --user disable --now hercule.service",
      "systemctl --user daemon-reload",
      SHOW,
    ]);
    expect(existsSync(unitFile)).toBe(false);
  });

  it("succeeds when nothing is installed", async () => {
    const { result } = await runOnTestClock(supervisor().uninstall);
    expect(expectSuccess(result).installed).toBe(false);
    expect(calls).toEqual([SHOW]);
  });

  it("says that lingering stays on", () => {
    expect(supervisor().uninstallNote).toBe(
      "Lingering stays on for ada. To turn it off, run `sudo loginctl disable-linger ada`.",
    );
  });
});

describe("readStatus", () => {
  it("reports a unit edited by hand as installed, with no role or Home", async () => {
    writeFileSync(unitFile, "[Service]\nExecStart=/usr/bin/true\n");
    state.pid = 77;
    const { result } = await runOnTestClock(supervisor().readStatus);
    expect(expectSuccess(result)).toEqual({
      installed: true,
      running: true,
      pid: 77,
      role: null,
      home: null,
      unitFile,
    });
  });
});
