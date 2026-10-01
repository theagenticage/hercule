/**
 * The launchd Supervisor against a fake `launchctl` and `plutil`: a small
 * model of the one job launchd holds for the label. The tests check the
 * commands each verb runs, in order, and what it reports.
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
import { createLaunchdSupervisor, parseLaunchdPid } from "./launchd";
import { runCommand, type RunCommand } from "./supervisor";
import { answer, expectSuccess, readFailureMessage, runOnTestClock } from "./testing";
import { renderLaunchdPlist, type ServiceUnit } from "./unit";

const UID = 501;
const TARGET = `gui/${UID}/sh.hercule.service`;

/** The LaunchAgent install.sh wrote before `hercule service install` existed. */
const buildLegacyPlist = (home: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>sh.hercule.service</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>/Users/ada/.local/bin/hercule</string>
\t\t<string>serve</string>
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/Users/ada/.local/bin:/usr/bin</string>
\t\t<key>HERCULE_HOME</key>
\t\t<string>${home}</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${home}/logs/controller.log</string>
\t<key>StandardErrorPath</key>
\t<string>${home}/logs/controller.log</string>
</dict>
</plist>
`;

const unescapeXml = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/**
 * Converts the two plist shapes these tests write to the JSON
 * `plutil -convert json` prints, keeping only the keys the Supervisor reads.
 */
const convertPlist = (text: string): string => {
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text)?.[1] ?? "";
  const home = /<key>HERCULE_HOME<\/key>\s*<string>(.*?)<\/string>/.exec(text)?.[1];
  return JSON.stringify({
    ProgramArguments: [...program.matchAll(/<string>(.*?)<\/string>/g)].map((m) =>
      unescapeXml(m[1]!),
    ),
    ...(home === undefined ? {} : { EnvironmentVariables: { HERCULE_HOME: unescapeXml(home) } }),
  });
};

/** What the fake launchd holds, and how it behaves. Tests change it to set up a case. */
interface LaunchdState {
  /** Whether the user has a GUI session, so `gui/<uid>` exists. */
  session: boolean;
  loaded: boolean;
  pid: number | null;
  /** The process never starts: launchd holds the job and runs nothing. */
  neverStarts: boolean;
  /** The process exits at boot, so launchd starts it again under a new pid on every look. */
  crashLoop: boolean;
  /** How many `print` calls still show the job, on its way out, after a bootout. */
  slowUnload: number;
  /** How many more `print` calls show the job on its way out, counting down from `slowUnload`. */
  unloading: number;
}

let scratch: string;
let unitDir: string;
let home: string;
let unitFile: string;
let state: LaunchdState;
let calls: Array<string>;
let nextPid: number;

const startProcess = (): void => {
  state.pid = state.neverStarts ? null : nextPid++;
};

const fakeRun: RunCommand = (argv) =>
  Effect.sync(() => {
    const line = argv.join(" ");
    calls.push(line);
    const [command, verb] = argv;
    if (command === "plutil") {
      const path = argv.at(-1)!;
      return existsSync(path) ? answer(0, convertPlist(readFileSync(path, "utf8"))) : answer(1);
    }
    if (command !== "launchctl") return answer(127, "", `${command}: not found`);
    switch (verb) {
      case "print":
        if (argv[2] === `gui/${UID}`)
          return state.session ? answer(0, "domain = gui") : answer(113);
        if (state.unloading > 0) {
          state.unloading -= 1;
          if (state.unloading === 0) state.loaded = false;
          return answer(0, `${TARGET} = {\n\tstate = exiting\n}`);
        }
        if (!state.loaded) return answer(113, "", `Could not find service "sh.hercule.service"`);
        if (state.crashLoop) startProcess();
        return answer(
          0,
          `${TARGET} = {\n\tactive count = 1\n\tstate = running\n${state.pid === null ? "" : `\tpid = ${state.pid}\n`}\tlast exit code = 0\n}`,
        );
      case "bootstrap":
        if (state.loaded) return answer(5, "", "Bootstrap failed: 5: Input/output error");
        state.loaded = true;
        startProcess();
        return answer(0);
      case "bootout":
        if (!state.loaded) return answer(3, "", "Boot-out failed: 3: No such process");
        state.pid = null;
        state.unloading = state.slowUnload;
        if (state.unloading === 0) state.loaded = false;
        return answer(0);
      case "kickstart":
        if (!state.loaded) return answer(113);
        if (argv.includes("-k") || state.pid === null) startProcess();
        return answer(0);
      default:
        return answer(1);
    }
  });

const supervisor = () =>
  createLaunchdSupervisor({ run: fakeRun, unitDir, uid: UID, userName: "ada" });

const buildUnit = (overrides: Partial<ServiceUnit> = {}): ServiceUnit => ({
  role: "serve",
  program: "/Users/ada/.local/bin/hercule",
  home,
  path: "/Users/ada/.local/bin:/usr/bin",
  stderrLog: join(home, "logs", "controller.stderr.log"),
  ...overrides,
});

/** Writes a plist and loads it in the fake, as a previous install would have. */
const installBefore = (text: string, pid: number | null = 100): void => {
  writeFileSync(unitFile, text);
  state.loaded = true;
  state.pid = pid;
};

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "hercule-launchd-"));
  unitDir = join(scratch, "LaunchAgents");
  home = join(scratch, "home");
  unitFile = join(unitDir, "sh.hercule.service.plist");
  mkdirSync(unitDir);
  state = {
    session: true,
    loaded: false,
    pid: null,
    neverStarts: false,
    crashLoop: false,
    slowUnload: 0,
    unloading: 0,
  };
  calls = [];
  nextPid = 200;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("parseLaunchdPid", () => {
  it("reads the pid line, and nothing else that mentions a pid", () => {
    expect(parseLaunchdPid("x = {\n\tstate = running\n\tpid = 4242\n\tparent pid = 1\n}")).toBe(
      4242,
    );
    expect(parseLaunchdPid("x = {\n\tstate = not running\n\tlast exit code = 1\n}")).toBeNull();
  });
});

describe("install", () => {
  it("writes the plist, bootstraps it, and waits for the process to keep its pid", async () => {
    const { result, seconds } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(expectSuccess(result)).toEqual({
      installed: true,
      running: true,
      pid: 200,
      role: "serve",
      home,
      unitFile,
    });
    expect(calls).toEqual([
      `launchctl print gui/${UID}`,
      `launchctl print ${TARGET}`,
      `launchctl bootstrap gui/${UID} ${unitFile}`,
      `launchctl print ${TARGET}`,
      `launchctl print ${TARGET}`,
      `plutil -convert json -o - ${unitFile}`,
      `launchctl print ${TARGET}`,
    ]);
    expect(seconds).toBe(3);
    expect(readFileSync(unitFile, "utf8")).toBe(renderLaunchdPlist(buildUnit()));
    expect(statSync(unitFile).mode & 0o777).toBe(0o644);
    expect(statSync(join(home, "logs")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "logs", "controller.stderr.log")).mode & 0o777).toBe(0o600);
  });

  it("restarts the loaded job with kickstart -k when the plist is unchanged", async () => {
    installBefore(renderLaunchdPlist(buildUnit()));
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(expectSuccess(result).pid).toBe(200);
    expect(calls).toEqual([
      `launchctl print gui/${UID}`,
      `plutil -convert json -o - ${unitFile}`,
      `launchctl print ${TARGET}`,
      `launchctl kickstart -k ${TARGET}`,
      `launchctl print ${TARGET}`,
      `launchctl print ${TARGET}`,
      `plutil -convert json -o - ${unitFile}`,
      `launchctl print ${TARGET}`,
    ]);
  });

  it("boots out the loaded job, waits until it is gone, and bootstraps a changed plist", async () => {
    installBefore(renderLaunchdPlist(buildUnit({ path: "/usr/bin" })));
    state.slowUnload = 2;
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(expectSuccess(result).pid).toBe(200);
    expect(calls.slice(0, 8)).toEqual([
      `launchctl print gui/${UID}`,
      `plutil -convert json -o - ${unitFile}`,
      `launchctl print ${TARGET}`,
      `launchctl bootout ${TARGET}`,
      `launchctl print ${TARGET}`,
      `launchctl print ${TARGET}`,
      `launchctl print ${TARGET}`,
      `launchctl bootstrap gui/${UID} ${unitFile}`,
    ]);
    expect(readFileSync(unitFile, "utf8")).toBe(renderLaunchdPlist(buildUnit()));
  });

  it("replaces the LaunchAgent install.sh wrote for the same Home", async () => {
    installBefore(buildLegacyPlist(home));
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(expectSuccess(result)).toMatchObject({ running: true, pid: 200, role: "serve", home });
    expect(calls).toContain(`launchctl bootout ${TARGET}`);
    expect(calls).toContain(`launchctl bootstrap gui/${UID} ${unitFile}`);
    expect(readFileSync(unitFile, "utf8")).toBe(renderLaunchdPlist(buildUnit()));
  });

  it("counts a Home spelled with a trailing slash as the same Home", async () => {
    installBefore(buildLegacyPlist(`${home}/`));
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(expectSuccess(result).home).toBe(home);
  });

  it("refuses when the installed unit runs another Home, and changes nothing", async () => {
    const legacy = buildLegacyPlist("/Users/ada/other-home");
    installBefore(legacy);
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toBe(
      "The Hercule service on this machine runs the Hercule Home /Users/ada/other-home, and there is one unit per machine. To keep it, run this with --home /Users/ada/other-home; to replace it, run `hercule service uninstall` first.",
    );
    expect(calls).toEqual([`launchctl print gui/${UID}`, `plutil -convert json -o - ${unitFile}`]);
    expect(readFileSync(unitFile, "utf8")).toBe(legacy);
  });

  it("refuses when the user is not logged in to the desktop, and writes nothing", async () => {
    state.session = false;
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toBe(
      "ada is not logged in to this Mac's desktop, so launchd has nowhere to run Hercule. Run this in Terminal on the Mac itself.",
    );
    expect(calls).toEqual([`launchctl print gui/${UID}`]);
    expect(existsSync(unitFile)).toBe(false);
  });

  it("fails after 30 seconds, pointing at the logs, when no process starts", async () => {
    state.neverStarts = true;
    const { result, seconds } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toBe(
      `The Hercule service did not start within 30 seconds. See ${home}/logs/controller.log and ${home}/logs/controller.stderr.log for the reason.`,
    );
    expect(seconds).toBe(30);
  });

  it("fails when the process does not keep its pid for three seconds", async () => {
    state.crashLoop = true;
    const { result, seconds } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toBe(
      `The Hercule service stopped right after it started. See ${home}/logs/controller.log and ${home}/logs/controller.stderr.log for the reason.`,
    );
    expect(seconds).toBe(3);
  });

  it("does not count the pid from before the install as started", async () => {
    installBefore(renderLaunchdPlist(buildUnit()), 100);
    // kickstart -k that leaves the old process running looks like no restart at all.
    nextPid = 100;
    const { result } = await runOnTestClock(supervisor().install(buildUnit()));
    expect(readFailureMessage(result)).toContain("did not start within 30 seconds");
  });
});

describe("start", () => {
  it("fails with the exact message when no unit is installed, and installs nothing", async () => {
    const { result } = await runOnTestClock(supervisor().start);
    expect(readFailureMessage(result)).toBe(
      "No Hercule service is installed on this machine. Run `hercule service install`.",
    );
    expect(calls).toEqual([]);
    expect(existsSync(unitFile)).toBe(false);
  });

  it("bootstraps a unit that is not loaded", async () => {
    writeFileSync(unitFile, renderLaunchdPlist(buildUnit()));
    const { result } = await runOnTestClock(supervisor().start);
    expect(expectSuccess(result)).toMatchObject({ running: true, pid: 200 });
    expect(calls).toEqual([
      `plutil -convert json -o - ${unitFile}`,
      `launchctl print ${TARGET}`,
      `launchctl bootstrap gui/${UID} ${unitFile}`,
      `launchctl print ${TARGET}`,
      `launchctl print ${TARGET}`,
      `plutil -convert json -o - ${unitFile}`,
      `launchctl print ${TARGET}`,
    ]);
  });

  it("kickstarts a loaded job that runs no process", async () => {
    installBefore(renderLaunchdPlist(buildUnit()), null);
    const { result } = await runOnTestClock(supervisor().start);
    expect(expectSuccess(result).pid).toBe(200);
    expect(calls).toContain(`launchctl kickstart ${TARGET}`);
  });

  it("does nothing to a running process", async () => {
    installBefore(renderLaunchdPlist(buildUnit()), 100);
    const { result, seconds } = await runOnTestClock(supervisor().start);
    expect(expectSuccess(result).pid).toBe(100);
    expect(calls.filter((line) => !line.includes(" print ") && !line.startsWith("plutil"))).toEqual(
      [],
    );
    expect(seconds).toBe(0);
  });
});

describe("stop", () => {
  it("boots out the job and keeps the plist", async () => {
    installBefore(renderLaunchdPlist(buildUnit()), 100);
    const { result } = await runOnTestClock(supervisor().stop);
    expect(expectSuccess(result)).toMatchObject({ installed: true, running: false, pid: null });
    expect(calls).toContain(`launchctl bootout ${TARGET}`);
    expect(existsSync(unitFile)).toBe(true);
  });

  it("fails when no unit is installed", async () => {
    const { result } = await runOnTestClock(supervisor().stop);
    expect(readFailureMessage(result)).toContain("No Hercule service is installed");
  });
});

describe("restart", () => {
  it("kickstarts a loaded job with -k and waits for the new pid", async () => {
    installBefore(renderLaunchdPlist(buildUnit()), 100);
    const { result } = await runOnTestClock(supervisor().restart);
    expect(expectSuccess(result).pid).toBe(200);
    expect(calls).toContain(`launchctl kickstart -k ${TARGET}`);
  });

  it("bootstraps a job that is not loaded", async () => {
    installBefore(renderLaunchdPlist(buildUnit()), null);
    state.loaded = false;
    const { result } = await runOnTestClock(supervisor().restart);
    expect(expectSuccess(result).pid).toBe(200);
    expect(calls).toContain(`launchctl bootstrap gui/${UID} ${unitFile}`);
  });

  it("fails when no unit is installed", async () => {
    const { result } = await runOnTestClock(supervisor().restart);
    expect(readFailureMessage(result)).toContain("No Hercule service is installed");
  });
});

describe("uninstall", () => {
  it("boots out the job and deletes the plist", async () => {
    installBefore(renderLaunchdPlist(buildUnit()), 100);
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
      `launchctl print ${TARGET}`,
      `launchctl bootout ${TARGET}`,
      `launchctl print ${TARGET}`,
      `launchctl print ${TARGET}`,
    ]);
    expect(existsSync(unitFile)).toBe(false);
  });

  it("succeeds when nothing is installed", async () => {
    const { result } = await runOnTestClock(supervisor().uninstall);
    expect(expectSuccess(result).installed).toBe(false);
    expect(calls).toEqual([`launchctl print ${TARGET}`, `launchctl print ${TARGET}`]);
  });
});

describe("readStatus", () => {
  it("reads the role and the Home from a plist install.sh wrote", async () => {
    installBefore(buildLegacyPlist("/Users/ada/.hercule"), 321);
    const { result } = await runOnTestClock(supervisor().readStatus);
    expect(expectSuccess(result)).toEqual({
      installed: true,
      running: true,
      pid: 321,
      role: "serve",
      home: "/Users/ada/.hercule",
      unitFile,
    });
  });

  it("fails with what to do when plutil cannot read the plist", async () => {
    writeFileSync(unitFile, "not a plist");
    const failing: RunCommand = (argv) =>
      argv[0] === "plutil" ? Effect.succeed(answer(1, "not a plist")) : fakeRun(argv);
    const { result } = await runOnTestClock(
      createLaunchdSupervisor({ run: failing, unitDir, uid: UID, userName: "ada" }).readStatus,
    );
    expect(readFailureMessage(result)).toBe(
      `${unitFile} is not a plist Hercule can read. Delete it and run \`hercule service install\`.`,
    );
  });
});

// plutil only converts files and changes nothing on the machine, so the real
// one checks that both plist shapes are valid and read the way the fake reads them.
describe.skipIf(process.platform !== "darwin")("the real plutil", () => {
  it("reads a rendered plist with awkward characters, and the plist install.sh wrote", async () => {
    const awkward = buildUnit({ program: "/opt/a & b/<x>/hercule", home: "/Users/ada/a & b" });
    for (const text of [renderLaunchdPlist(awkward), buildLegacyPlist("/Users/ada/a &amp; b")]) {
      writeFileSync(unitFile, text);
      const converted = await Effect.runPromise(
        runCommand(["plutil", "-convert", "json", "-o", "-", unitFile]),
      );
      expect(converted.exitCode).toBe(0);
      const plist: unknown = JSON.parse(converted.stdout);
      expect(plist).toMatchObject({
        ProgramArguments: [expect.any(String), "serve"],
        EnvironmentVariables: { HERCULE_HOME: "/Users/ada/a & b" },
      });
      // The fake plutil above must read both plists the way the real one does.
      expect(plist).toMatchObject(JSON.parse(convertPlist(text)) as object);
    }
  });
});
