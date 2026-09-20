/**
 * What the runner puts on the machine once, at start, so that every session it
 * hosts can reach Hercule: the `hercule` binary on a directory it prepends to
 * PATH (spec 15 section 2) and the Claude plugin directory the skill is
 * materialized into (spec 06 section 9.3).
 *
 * Both are refreshed rather than written once, because an upgraded binary must
 * take over an older build's symlink and an older build's skill text.
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

const root = (): string => {
  const made = mkdtempSync(join(tmpdir(), "hercule-tooling-"));
  roots.push(made);
  return made;
};

const SKILL = "# hercule\n\nCall `hercule --help` to find out what this controller can do.\n";

/** A home and a storage directory of one runner, with a binary to point at. */
const machine = (): {
  readonly home: string;
  readonly storageDir: string;
  readonly execPath: string;
} => {
  const under = root();
  const home = join(under, "home");
  const storageDir = join(under, "home", "runner", "controller-one");
  mkdirSync(storageDir, { recursive: true });
  const execPath = join(under, "hercule-binary");
  writeFileSync(execPath, "#!/bin/sh\n", { mode: 0o755 });
  return { home, storageDir, execPath };
};

describe("the hercule binary a session calls", () => {
  it("is a symlink to this running binary, on the directory sessions get on PATH", () => {
    const { home, storageDir, execPath } = machine();

    const { binDir } = prepareTooling({ home, storageDir, execPath, skill: SKILL });

    // The very path spec 15 section 2 names, because the PATH prepend and this
    // are two halves of one promise: `which hercule` works inside a session.
    expect(binDir).toBe(join(home, "runner", "bin"));
    const link = join(binDir, "hercule");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(execPath);
  });

  it("re-points a symlink an older build left behind", () => {
    const { home, storageDir, execPath } = machine();
    const binDir = join(home, "runner", "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync(join(home, "a-binary-that-was-replaced"), join(binDir, "hercule"));

    prepareTooling({ home, storageDir, execPath, skill: SKILL });

    // Refreshed at every runner start, so an upgrade follows rather than
    // leaving every session calling the build that was replaced.
    expect(readlinkSync(join(binDir, "hercule"))).toBe(execPath);
  });
});

describe("the Claude plugin directory the skill is materialized into", () => {
  it("is a loadable plugin under the runner's own storage, carrying the skill", () => {
    const { home, storageDir, execPath } = machine();

    const {
      herculeTool: { claudePluginDir },
    } = prepareTooling({ home, storageDir, execPath, skill: SKILL });

    // Under the runner's storage, so re-enlisting the machine takes it with
    // the identity it belonged to, and never in a Thread's own `.claude/`.
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
    const { home, storageDir, execPath } = machine();
    const first = prepareTooling({
      home,
      storageDir,
      execPath,
      skill: "what the previous build said",
    });
    expect(
      readFileSync(join(first.herculeTool.claudePluginDir, "skills", "hercule", "SKILL.md"), "utf8"),
    ).toContain("what the previous build said");

    const {
      herculeTool: { claudePluginDir },
    } = prepareTooling({ home, storageDir, execPath, skill: SKILL });

    // Stale skill text teaches an agent commands this build may no longer
    // spell that way, and nothing else on the machine ever rewrites it.
    const written = readFileSync(join(claudePluginDir, "skills", "hercule", "SKILL.md"), "utf8");
    expect(written).toContain(SKILL);
    expect(written).not.toContain("what the previous build said");
  });
});
