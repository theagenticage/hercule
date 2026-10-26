/**
 * Runs the real `gh` shim with `/bin/sh`, beside a fake `hercule` and a fake
 * `gh` that print what they were given, and checks what the fake `gh` sees:
 * which token, which arguments, and which `PATH`.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGhShim } from "./gh-shim";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ORIGINAL_TOKEN = "ghs_original";
const FRESH_TOKEN = "ghs_fresh";
const REFUSAL = "hercule: no fresh GitHub token (the Connection 'Work' needs reconnecting)";

const FALLBACK_LINE =
  "hercule: running gh with the session's original token. To act as this machine's own gh login instead, ask the user once in this thread, then run: env -u GH_TOKEN gh ...";

const writeScript = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\n${body}`);
  chmodSync(path, 0o755);
};

interface Machine {
  /**
   * Runs the shim with these arguments and environment. `PATH` is, unless
   * `pathEntries` says otherwise, the bin directory, the gh directory, an empty
   * entry and the bin directory again. A run that does not end within 10
   * seconds is killed and reports a non-zero exit code.
   */
  readonly run: (
    args: ReadonlyArray<string>,
    env: Record<string, string>,
    pathEntries?: ReadonlyArray<string>,
    cwd?: string,
  ) => { readonly stdout: string; readonly stderr: string; readonly exitCode: number };
  readonly herculeRan: () => boolean;
  readonly binDir: string;
  readonly ghDir: string;
  /** A symlink to the bin directory. */
  readonly binLink: string;
  /** The `PATH` the fake gh should see: the one the shim was given, without the bin directory. */
  readonly expectedPath: string;
}

/**
 * Creates a bin directory whose path has a space and a quote in it, with the
 * shim and a fake `hercule`, and a second directory with a fake `gh`. The fake
 * `gh` prints its `GH_TOKEN`, its arguments one per line, and its `PATH`, and
 * exits with 7.
 */
const createMachine = (options: {
  readonly hercule: "token" | "refusal" | "empty" | "noisy";
  readonly gh: boolean;
}): Machine => {
  const root = mkdtempSync(join(tmpdir(), "hercule-gh-shim-"));
  roots.push(root);
  const binDir = join(root, "it's a bin");
  const ghDir = join(root, "gh-dir");
  const marker = join(root, "hercule-ran");
  mkdirSync(binDir);
  mkdirSync(ghDir);
  const binLink = join(root, "bin-link");
  symlinkSync(binDir, binLink);
  writeFileSync(join(binDir, "gh"), buildGhShim(binDir), { mode: 0o755 });
  writeScript(
    join(binDir, "hercule"),
    {
      token: `: > '${marker}'\necho ${FRESH_TOKEN}\n`,
      refusal: `: > '${marker}'\necho "${REFUSAL}" >&2\nexit 1\n`,
      empty: `: > '${marker}'\nexit 0\n`,
      noisy: `: > '${marker}'\necho "a warning" >&2\necho ${FRESH_TOKEN}\n`,
    }[options.hercule],
  );
  if (options.gh) {
    writeScript(
      join(ghDir, "gh"),
      `echo "token=\${GH_TOKEN-unset}"\nfor a in "$@"; do echo "arg=$a"; done\necho "path=$PATH"\nexit 7\n`,
    );
  }
  return {
    run: (args, env, pathEntries = [binDir, ghDir, "", binDir], cwd = root) => {
      const done = Bun.spawnSync(["/bin/sh", join(binDir, "gh"), ...args], {
        env: { ...env, PATH: pathEntries.join(":") },
        cwd,
        timeout: 10_000,
      });
      return {
        stdout: done.stdout.toString(),
        stderr: done.stderr.toString(),
        exitCode: done.exitCode,
      };
    },
    herculeRan: () => existsSync(marker),
    binDir,
    ghDir,
    binLink,
    expectedPath: `${ghDir}:`,
  };
};

describe("the gh shim", () => {
  it("runs gh with a fresh token, the arguments unchanged, and without itself on PATH", () => {
    const machine = createMachine({ hercule: "token", gh: true });

    const result = machine.run(["pr", "list", "a b", "it's", ""], { GH_TOKEN: ORIGINAL_TOKEN });

    expect(result.stdout).toBe(
      [
        `token=${FRESH_TOKEN}`,
        "arg=pr",
        "arg=list",
        "arg=a b",
        "arg=it's",
        "arg=",
        // Every occurrence of the bin directory is gone, and the other entries
        // keep their order, including the empty one.
        `path=${machine.expectedPath}`,
        "",
      ].join("\n"),
    );
    expect(result.stderr).toBe("");
    // gh's exit code is the caller's.
    expect(result.exitCode).toBe(7);
  });

  it("keeps the session's own token and adds one line to the client's reason when no fresh token can be had", () => {
    const machine = createMachine({ hercule: "refusal", gh: true });

    const result = machine.run(["auth", "status"], { GH_TOKEN: ORIGINAL_TOKEN });

    expect(result.stdout).toContain(`token=${ORIGINAL_TOKEN}\n`);
    expect(result.stderr).toBe(`${REFUSAL}\n${FALLBACK_LINE}\n`);
    expect(result.exitCode).toBe(7);
  });

  it("never sets an empty GH_TOKEN when hercule exits 0 and prints nothing", () => {
    const machine = createMachine({ hercule: "empty", gh: true });

    const result = machine.run(["auth", "status"], { GH_TOKEN: ORIGINAL_TOKEN });

    expect(result.stdout).toContain(`token=${ORIGINAL_TOKEN}\n`);
    expect(result.stderr).toBe(`${FALLBACK_LINE}\n`);
  });

  it("keeps stderr output of a successful hercule out of GH_TOKEN", () => {
    const machine = createMachine({ hercule: "noisy", gh: true });

    const result = machine.run([], { GH_TOKEN: ORIGINAL_TOKEN });

    expect(result.stdout).toContain(`token=${FRESH_TOKEN}\n`);
    expect(result.stderr).toBe("a warning\n");
  });

  describe.each([
    ["with a trailing slash", (m: Machine) => `${m.binDir}/`],
    ["with a doubled slash", (m: Machine) => `${m.binDir}//`],
    ["through a symlink", (m: Machine) => m.binLink],
    ["through a symlink with a trailing slash", (m: Machine) => `${m.binLink}/`],
  ])("when PATH spells the bin directory %s", (_name, spell) => {
    it.each([{ GH_TOKEN: ORIGINAL_TOKEN }, {}])(
      "reaches the real gh exactly once (env %j)",
      (env) => {
        const machine = createMachine({ hercule: "token", gh: true });

        const result = machine.run(["x"], env, [spell(machine), machine.ghDir]);

        expect(result.exitCode).toBe(7);
        expect(result.stdout.match(/^token=/gm)).toHaveLength(1);
        expect(result.stdout).toContain(`path=${machine.ghDir}\n`);
      },
    );
  });

  it("treats an empty PATH entry as the current directory, so it is removed when that is the bin directory", () => {
    const machine = createMachine({ hercule: "token", gh: true });

    const result = machine.run(["x"], {}, [machine.binDir, "", machine.ghDir], machine.binDir);

    expect(result.exitCode).toBe(7);
    expect(result.stdout.match(/^token=/gm)).toHaveLength(1);
    expect(result.stdout).toContain(`path=${machine.ghDir}\n`);
  });

  it("exits 127 instead of running with an empty PATH when the bin directory was the only entry", () => {
    const machine = createMachine({ hercule: "token", gh: true });

    const result = machine.run(["x"], { GH_TOKEN: ORIGINAL_TOKEN }, [machine.binDir]);

    expect(result.exitCode).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("gh: command not found\n");
    expect(machine.herculeRan()).toBe(false);
  });

  it("changes nothing and asks for nothing when GH_TOKEN is not set", () => {
    const machine = createMachine({ hercule: "token", gh: true });

    const result = machine.run(["auth", "status"], {});

    // This is also how `env -u GH_TOKEN gh` works.
    expect(machine.herculeRan()).toBe(false);
    expect(result.stdout).toContain("token=unset\n");
    expect(result.stderr).toBe("");
  });

  it("treats an empty GH_TOKEN as set", () => {
    const machine = createMachine({ hercule: "token", gh: true });

    const result = machine.run([], { GH_TOKEN: "" });

    expect(result.stdout).toContain(`token=${FRESH_TOKEN}\n`);
  });

  it("exits 127 when gh is not installed", () => {
    const machine = createMachine({ hercule: "token", gh: false });

    const result = machine.run(["--version"], { GH_TOKEN: ORIGINAL_TOKEN });

    expect(result.exitCode).toBe(127);
  });
});
