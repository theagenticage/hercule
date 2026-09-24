/**
 * Tests what the runner prepares on the machine at start, so that every session
 * it hosts can reach Hercule: the `hercule` binary in a directory it puts at the
 * front of PATH (spec 15 section 2), and the Claude plugin directory that holds
 * the skill (spec 06 section 9.3).
 *
 * Both are rewritten at every start, because an upgraded binary must replace an
 * older build's symlink and an older build's skill text.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareTooling } from "./tooling";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createRoot = (): string => {
  const made = mkdtempSync(join(tmpdir(), "hercule-tooling-"));
  roots.push(made);
  return made;
};

const SKILL = "# hercule\n\nCall `hercule --help` to find out what this controller can do.\n";

/** Creates a Hercule Home, a runner storage directory, and a fake binary for the symlink to point at. */
const createMachine = (): {
  readonly home: string;
  readonly storageDir: string;
  readonly execPath: string;
} => {
  const under = createRoot();
  const home = join(under, "home");
  const storageDir = join(under, "home", "runner", "controller-one");
  mkdirSync(storageDir, { recursive: true });
  const execPath = join(under, "hercule-binary");
  writeFileSync(execPath, "#!/bin/sh\n", { mode: 0o755 });
  return { home, storageDir, execPath };
};

describe("the hercule binary a session calls", () => {
  it("is a symlink to this running binary, on the directory sessions get on PATH", () => {
    const { home, storageDir, execPath } = createMachine();

    const { binDir } = prepareTooling({ home, storageDir, execPath, skill: SKILL });

    // The exact path spec 15 section 2 names. Together with the PATH change, it
    // makes `which hercule` work inside a session.
    expect(binDir).toBe(join(home, "runner", "bin"));
    const link = join(binDir, "hercule");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(execPath);
  });

  it("re-points a symlink an older build left behind", () => {
    const { home, storageDir, execPath } = createMachine();
    const binDir = join(home, "runner", "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(home, "a-binary-that-was-replaced"), join(binDir, "hercule"));

    prepareTooling({ home, storageDir, execPath, skill: SKILL });

    // The link is rewritten at every runner start, so after an upgrade the
    // sessions call the new build, not the one it replaced.
    expect(readlinkSync(join(binDir, "hercule"))).toBe(execPath);
  });
});

describe("the Claude plugin directory that holds the skill", () => {
  it("is a loadable plugin under the runner's storage directory, and contains the skill", () => {
    const { home, storageDir, execPath } = createMachine();

    const {
      herculeTool: { claudePluginDir },
    } = prepareTooling({ home, storageDir, execPath, skill: SKILL });

    // It lives under the runner's storage directory, so it goes away with the
    // identity when the machine is enlisted again. It is never written into a
    // Thread's own `.claude/`.
    expect(claudePluginDir.startsWith(storageDir)).toBe(true);
    // The two files the SDK needs to load a local plugin and find its skill.
    const manifest = join(claudePluginDir, ".claude-plugin", "plugin.json");
    expect(existsSync(manifest)).toBe(true);
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toMatchObject({ name: "hercule" });
    expect(readFileSync(join(claudePluginDir, "skills", "hercule", "SKILL.md"), "utf8")).toContain(
      SKILL,
    );
  });

  it("overwrites the skill text an older build wrote", () => {
    const { home, storageDir, execPath } = createMachine();
    const first = prepareTooling({
      home,
      storageDir,
      execPath,
      skill: "what the previous build said",
    });
    expect(
      readFileSync(
        join(first.herculeTool.claudePluginDir, "skills", "hercule", "SKILL.md"),
        "utf8",
      ),
    ).toContain("what the previous build said");

    const {
      herculeTool: { claudePluginDir },
    } = prepareTooling({ home, storageDir, execPath, skill: SKILL });

    // Stale skill text could teach an agent commands this build no longer has,
    // and nothing else on the machine rewrites it.
    const written = readFileSync(join(claudePluginDir, "skills", "hercule", "SKILL.md"), "utf8");
    expect(written).toContain(SKILL);
    expect(written).not.toContain("what the previous build said");
  });
});
