/**
 * Tests what the runner prepares on the machine at start, so that every session
 * it hosts can reach Hercule: the `hercule` binary and the `gh` shim in a
 * directory it puts at the front of PATH (spec 15 section 2), and the Claude
 * plugin directory that holds the skill (spec 06 section 9.3).
 *
 * All of them are rewritten at every start, because an upgraded binary must replace an
 * older build's symlink and an older build's skill text.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGhShim } from "./gh-shim";
import { SKILL_DESCRIPTION } from "./skill";
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
const ORIENTATION = "This session runs inside Hercule.";

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

    const { binDir } = prepareTooling({
      home,
      storageDir,
      execPath,
      orientation: ORIENTATION,
      skill: SKILL,
    });

    // The bin directory has one fixed place, `<home>/runner/bin`
    // (spec 15 section 2). Together with the PATH change, it makes
    // `which hercule` work inside a session.
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

    prepareTooling({ home, storageDir, execPath, orientation: ORIENTATION, skill: SKILL });

    // The link is rewritten at every runner start, so after an upgrade the
    // sessions call the new build, not the one it replaced.
    expect(readlinkSync(join(binDir, "hercule"))).toBe(execPath);
  });
});

describe("the gh a session calls", () => {
  it("is an executable script beside the hercule symlink, rewritten at every start", () => {
    const { home, storageDir, execPath } = createMachine();
    const binDir = join(home, "runner", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "gh"), "what an older build wrote");

    prepareTooling({ home, storageDir, execPath, orientation: ORIENTATION, skill: SKILL });

    const shim = join(binDir, "gh");
    expect(readFileSync(shim, "utf8")).toBe(buildGhShim(binDir));
    expect(statSync(shim).mode & 0o111).not.toBe(0);
    // Starting again leaves the shim in place and executable.
    prepareTooling({ home, storageDir, execPath, orientation: ORIENTATION, skill: SKILL });
    expect(readFileSync(shim, "utf8")).toBe(buildGhShim(binDir));
    expect(statSync(shim).mode & 0o111).not.toBe(0);
  });
});

describe("the Claude plugin directory that holds the skill", () => {
  it("is a loadable plugin under the runner's storage directory, and contains the skill", () => {
    const { home, storageDir, execPath } = createMachine();

    const {
      herculeTool: { claudePluginDir },
    } = prepareTooling({ home, storageDir, execPath, orientation: ORIENTATION, skill: SKILL });

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

  it("describes the skill in frontmatter that parses, in both the skill and the manifest", () => {
    const { home, storageDir, execPath } = createMachine();

    const {
      herculeTool: { claudePluginDir },
    } = prepareTooling({ home, storageDir, execPath, orientation: ORIENTATION, skill: SKILL });

    // The description is free prose. A colon followed by a space, written
    // bare, would make the YAML fail to parse, and the harness would then not
    // list the skill at all.
    const skillFile = readFileSync(join(claudePluginDir, "skills", "hercule", "SKILL.md"), "utf8");
    const frontmatter = skillFile.split("---\n")[1]!;
    expect(Bun.YAML.parse(frontmatter)).toEqual({
      name: "hercule",
      description: SKILL_DESCRIPTION,
    });
    const manifest = join(claudePluginDir, ".claude-plugin", "plugin.json");
    expect(JSON.parse(readFileSync(manifest, "utf8"))).toMatchObject({
      description: SKILL_DESCRIPTION,
    });
  });

  it("overwrites the skill text an older build wrote", () => {
    const { home, storageDir, execPath } = createMachine();
    const first = prepareTooling({
      home,
      storageDir,
      execPath,
      orientation: ORIENTATION,
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
    } = prepareTooling({ home, storageDir, execPath, orientation: ORIENTATION, skill: SKILL });

    // Stale skill text could teach an agent commands this build no longer has,
    // and nothing else on the machine rewrites it.
    const written = readFileSync(join(claudePluginDir, "skills", "hercule", "SKILL.md"), "utf8");
    expect(written).toContain(SKILL);
    expect(written).not.toContain("what the previous build said");
  });
});
