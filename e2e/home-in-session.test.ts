/**
 * Tests, through the release binary, that a command which acts on a
 * Hercule Home refuses to guess one inside a session.
 *
 * Inside a session the default Home can be the user's live one, so `hercule
 * serve`, the runner and `hercule service` must be given a Home by name. The
 * refusal happens in three roles, each with its own entrypoint, and the
 * dispatcher decides which role a command reaches, so only the binary shows
 * that every one of them refuses.
 *
 * Every command runs with `HOME` pointed at a scratch directory. If a refusal
 * were broken, the command would reach `<scratch>/.hercule`, never the
 * developer's own Home.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCleanEnv, ROOT, type Ran } from "../scripts/controller-process";
import { createTemporaryHome, type TemporaryHome } from "./harness";

const binary = join(ROOT, "hercule");

/** Stands in for the user's home directory; its `.hercule` is the default Home. */
let scratch: TemporaryHome;

/** The line every refusing role prints, before the reason. */
const REFUSAL = "hercule: --home: this command runs inside a Hercule session";

beforeAll(() => {
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  scratch = createTemporaryHome();
  // Before any command that could write runs, prove that the binary puts its
  // default Home under the scratch HOME. `hercule setup-url` only reads, and
  // its message names the file it looked for.
  const probe = runInSession(["setup-url"]);
  const expected = join(scratch.home, ".hercule", "setup-url");
  if (!probe.stderr.includes(expected) || existsSync(join(scratch.home, ".hercule"))) {
    throw new Error(
      `the binary did not resolve its default Home under the scratch HOME, so these tests could reach the real one. Expected ${expected} in: ${probe.stdout}${probe.stderr}`,
    );
  }
});

afterAll(() => {
  scratch?.remove();
});

/**
 * Runs the binary the way the runner starts it inside a session: with
 * `HERCULE_SESSION=1` and no other `HERCULE_` variable, so no `HERCULE_HOME`.
 * `runCli` cannot do this, because it always sets `HERCULE_HOME`.
 */
const runInSession = (args: ReadonlyArray<string>): Ran => {
  const ran = Bun.spawnSync([binary, ...args], {
    cwd: ROOT,
    env: { ...buildCleanEnv(), HOME: scratch.home, HERCULE_SESSION: "1" },
    stdin: "ignore",
    // A refusal is immediate. A command that was let through by mistake, such
    // as a daemon, is stopped here instead of hanging the suite.
    timeout: 20_000,
  });
  return { code: ran.exitCode, stdout: ran.stdout.toString(), stderr: ran.stderr.toString() };
};

/**
 * Every command that acts on a Home, and the code it exits with when it refuses.
 * `hercule serve` exits 1 for every failure to boot, a bad option included;
 * the runner and `hercule service` exit 2 for a usage error.
 */
const COMMANDS_THAT_ACT_ON_A_HOME = [
  { command: "serve", code: 1 },
  { command: "runner", code: 2 },
  { command: "runner --local", code: 2 },
  // `--no-service`, so that even a join let through by mistake could not
  // install a service unit for this user.
  { command: "runner join http://127.0.0.1:1 --token x --no-service", code: 2 },
  { command: "runner set-controller http://127.0.0.1:1", code: 2 },
  { command: "service status", code: 2 },
];

describe("a command run inside a session", () => {
  for (const { command, code } of COMMANDS_THAT_ACT_ON_A_HOME) {
    it(`refuses \`hercule ${command}\` with no Home named, names the default Home, and creates nothing`, () => {
      const ran = runInSession(command.split(" "));

      expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(code);
      expect(ran.stderr).toContain(REFUSAL);
      // The path in the message shows that the command resolved its default
      // Home under the scratch HOME, and so could not have reached the real one.
      expect(ran.stderr).toContain(join(scratch.home, ".hercule"));
      expect(existsSync(join(scratch.home, ".hercule"))).toBe(false);
    });
  }

  it("runs `hercule git-credential get`, which reads no Home, without refusing it", () => {
    // git calls this inside a session for every push, so a refusal would break
    // every session's git.
    const ran = runInSession(["git-credential", "get"]);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stderr).not.toContain(REFUSAL);
  });

  it("reports a mistyped runner option as a typo, not as a missing Home", () => {
    // The command line is checked before the Home, so the agent is told
    // about the mistake it can fix first.
    const ran = runInSession(["runner", "--locl"]);

    expect(ran.code).toBe(2);
    expect(ran.stderr).toContain("unknown runner option `--locl`");
    expect(ran.stderr).not.toContain(REFUSAL);
  });

  it("prints `hercule service --help` without asking for a Home", () => {
    const ran = runInSession(["service", "--help"]);

    expect(ran.code, ran.stderr).toBe(0);
    expect(ran.stdout).toContain("usage: hercule service");
  });

  it("lets `hercule serve --home <dir>` through", () => {
    const named = join(scratch.home, "named");

    // An invalid port fails the boot after the Home is chosen, so the command
    // ends at once and starts no controller. A refusal would have come first.
    const ran = runInSession(["serve", "--home", named, "-c", "bind.port=nope"]);

    expect(ran.code).toBe(1);
    expect(ran.stderr).not.toContain(REFUSAL);
    expect(ran.stderr).toContain("bind.port");
    expect(existsSync(join(named, "config.toml"))).toBe(true);
  });
});
