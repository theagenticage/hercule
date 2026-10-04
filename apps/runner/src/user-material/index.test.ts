/**
 * Tests what a Thread sees of the user's own material. Every test builds a
 * fake user home in a temporary directory; none reads the real one. Besides
 * what each provider gets, the tests guard two things the spec names:
 *
 * - Codex and pi never get anything written into their instance home, which
 *   every session of the instance shares;
 * - Claude Code's links never destroy a real file, and never dangle.
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Logger } from "effect";
import { CLAUDE_CODE, CODEX, PI } from "../providers";
import { cleanupHomes, createScratchHome, NO_USER_MATERIAL_PATHS } from "../providers/testing";
import { provisionUserMaterial } from "./index";

afterAll(cleanupHomes);

/** Writes a file, creating its parent directories, and returns its path. */
const writeFile = (path: string, content = "content"): string => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
};

/**
 * Writes a file nobody but root may read, and returns its path. Root reads it
 * anyway, so a test that needs a read to fail is skipped when run as root.
 */
const writeUnreadableFile = (path: string): string => {
  writeFile(path, "instructions nobody may read");
  chmodSync(path, 0o000);
  return path;
};

const RUNS_AS_ROOT = process.getuid?.() === 0;

/** Creates an empty fake user home and an empty instance home. */
const createHomes = (): { readonly home: string; readonly instanceHome: string } => ({
  home: createScratchHome("user"),
  instanceHome: createScratchHome("instance"),
});

/**
 * Provisions the user's material for one Thread and returns the material and
 * every warning logged while doing so.
 */
const provisionCapturingWarnings = (
  providerId: string,
  instanceHome: string,
  env: Record<string, string>,
) => {
  const warnings: Array<string> = [];
  const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });
  const material = Effect.runSync(
    Effect.provide(
      provisionUserMaterial(providerId, instanceHome, env),
      Logger.layer([collecting]),
    ),
  );
  return { material, warnings };
};

/** Provisions the user's material for one Thread and returns the material. */
const provision = (providerId: string, instanceHome: string, env: Record<string, string>) =>
  provisionCapturingWarnings(providerId, instanceHome, env).material;

describe("Claude Code's material", () => {
  it("links each entry of the user's .claude directory that exists, and only those", () => {
    const { home, instanceHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"), "be terse");
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });

    const material = provision(CLAUDE_CODE, instanceHome, { HOME: home });

    // Claude reads its material from the instance home, so it needs no paths.
    expect(material).toEqual(NO_USER_MATERIAL_PATHS);
    expect(readdirSync(instanceHome).sort()).toEqual(["CLAUDE.md", "agents"]);
    expect(readlinkSync(join(instanceHome, "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
    expect(readFileSync(join(instanceHome, "CLAUDE.md"), "utf8")).toBe("be terse");
  });

  it("resolves a relative symlink inside a linked directory, as it does for the user", () => {
    const { home, instanceHome } = createHomes();
    writeFile(join(home, ".agents", "skills", "implement", "SKILL.md"), "# implement");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    // What a skill manager makes: a relative link into the shared skills directory.
    symlinkSync("../../.agents/skills/implement", join(home, ".claude", "skills", "implement"));

    provision(CLAUDE_CODE, instanceHome, { HOME: home });

    expect(readFileSync(join(instanceHome, "skills", "implement", "SKILL.md"), "utf8")).toBe(
      "# implement",
    );
  });

  it("leaves a correct link as it is on a second start, with no temporary link left behind", () => {
    const { home, instanceHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"));
    provision(CLAUDE_CODE, instanceHome, { HOME: home });

    provision(CLAUDE_CODE, instanceHome, { HOME: home });

    expect(readdirSync(instanceHome)).toEqual(["CLAUDE.md"]);
    expect(readlinkSync(join(instanceHome, "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
  });

  it("removes a link whose source the user has removed, so it does not dangle", () => {
    const { home, instanceHome } = createHomes();
    const source = writeFile(join(home, ".claude", "CLAUDE.md"));
    provision(CLAUDE_CODE, instanceHome, { HOME: home });
    rmSync(source);

    provision(CLAUDE_CODE, instanceHome, { HOME: home });

    expect(readdirSync(instanceHome)).toEqual([]);
  });

  it("repoints a stale link at the user's entry", () => {
    const { home, instanceHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"), "the user's");
    symlinkSync(writeFile(join(home, "elsewhere.md"), "stale"), join(instanceHome, "CLAUDE.md"));

    provision(CLAUDE_CODE, instanceHome, { HOME: home });

    expect(readlinkSync(join(instanceHome, "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
    expect(readFileSync(join(instanceHome, "CLAUDE.md"), "utf8")).toBe("the user's");
  });

  it("never replaces a real file or directory in the instance home, and logs a warning for each", () => {
    const { home, instanceHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"), "the user's");
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    writeFile(join(instanceHome, "CLAUDE.md"), "already here");
    writeFile(join(instanceHome, "skills", "own", "SKILL.md"), "already here");

    const { material, warnings } = provisionCapturingWarnings(CLAUDE_CODE, instanceHome, {
      HOME: home,
    });

    expect(material).toEqual(NO_USER_MATERIAL_PATHS);
    expect(warnings).toEqual([
      expect.stringContaining(
        `${join(instanceHome, "skills")} already exists and is not a symlink`,
      ),
      expect.stringContaining(
        `${join(instanceHome, "CLAUDE.md")} already exists and is not a symlink`,
      ),
    ]);
    expect(lstatSync(join(instanceHome, "CLAUDE.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(instanceHome, "CLAUDE.md"), "utf8")).toBe("already here");
    expect(lstatSync(join(instanceHome, "skills")).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(instanceHome, "skills"))).toEqual(["own"]);
  });

  it("returns empty paths and does not fail when a link cannot be made, and logs a warning", () => {
    const { home } = createHomes();
    const source = writeFile(join(home, ".claude", "CLAUDE.md"));
    // A file where the instance home should be: every link fails with ENOTDIR.
    const notADirectory = writeFile(join(home, "not-a-directory"), "untouched");

    const { material, warnings } = provisionCapturingWarnings(CLAUDE_CODE, notADirectory, {
      HOME: home,
    });

    expect(material).toEqual(NO_USER_MATERIAL_PATHS);
    expect(readFileSync(notADirectory, "utf8")).toBe("untouched");
    // Only the entry the user has is worth a warning, not the four they lack.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Did not link ${source} into the Thread: `);
    expect(warnings[0]).toContain("ENOTDIR");
  });

  it("links nothing when the runner has no HOME", () => {
    const { instanceHome } = createHomes();

    expect(provision(CLAUDE_CODE, instanceHome, {})).toEqual(NO_USER_MATERIAL_PATHS);
    expect(readdirSync(instanceHome)).toEqual([]);
  });
});

describe("Codex's material", () => {
  it("prefers AGENTS.override.md over AGENTS.md, and writes nothing", () => {
    const { home, instanceHome } = createHomes();
    writeFile(join(home, ".codex", "AGENTS.md"));
    const override = writeFile(join(home, ".codex", "AGENTS.override.md"));

    const material = provision(CODEX, instanceHome, { HOME: home });

    expect(material).toEqual({ ...NO_USER_MATERIAL_PATHS, instructionsFile: override });
    // Every session of the instance shares its home; a link there would leak.
    expect(readdirSync(instanceHome)).toEqual([]);
  });

  it("reads AGENTS.md when there is no override, and nothing when there is neither", () => {
    const { home, instanceHome } = createHomes();
    // A missing file is the normal case, not worth a warning.
    expect(provisionCapturingWarnings(CODEX, instanceHome, { HOME: home })).toEqual({
      material: NO_USER_MATERIAL_PATHS,
      warnings: [],
    });

    const agents = writeFile(join(home, ".codex", "AGENTS.md"));

    expect(provision(CODEX, instanceHome, { HOME: home }).instructionsFile).toBe(agents);
  });

  it("reads the Codex home from CODEX_HOME when the runner has it set", () => {
    const { home, instanceHome } = createHomes();
    writeFile(join(home, ".codex", "AGENTS.md"));
    const elsewhere = createScratchHome("codex-home");
    const agents = writeFile(join(elsewhere, "AGENTS.md"));

    expect(
      provision(CODEX, instanceHome, { HOME: home, CODEX_HOME: elsewhere }).instructionsFile,
    ).toBe(agents);
    expect(readdirSync(instanceHome)).toEqual([]);
  });

  it("reads the .codex directory under HOME when CODEX_HOME is set but empty", () => {
    const { home, instanceHome } = createHomes();
    const agents = writeFile(join(home, ".codex", "AGENTS.md"));

    expect(provision(CODEX, instanceHome, { HOME: home, CODEX_HOME: "" }).instructionsFile).toBe(
      agents,
    );
  });

  it("falls through to AGENTS.md when the override holds only white space or is not a file", () => {
    const { home, instanceHome } = createHomes();
    const agents = writeFile(join(home, ".codex", "AGENTS.md"));
    const override = writeFile(join(home, ".codex", "AGENTS.override.md"), "");
    expect(provision(CODEX, instanceHome, { HOME: home }).instructionsFile).toBe(agents);

    writeFileSync(override, "  \n\n");
    expect(provision(CODEX, instanceHome, { HOME: home }).instructionsFile).toBe(agents);

    rmSync(override);
    mkdirSync(override);
    expect(provision(CODEX, instanceHome, { HOME: home }).instructionsFile).toBe(agents);
  });

  it.skipIf(RUNS_AS_ROOT)(
    "falls through a file it cannot read, as Codex does, and logs a warning for it",
    () => {
      const { home, instanceHome } = createHomes();
      const agents = writeFile(join(home, ".codex", "AGENTS.md"), "be terse");
      const override = writeUnreadableFile(join(home, ".codex", "AGENTS.override.md"));

      const fellThrough = provisionCapturingWarnings(CODEX, instanceHome, { HOME: home });

      expect(fellThrough.material.instructionsFile).toBe(agents);
      expect(fellThrough.warnings).toHaveLength(1);
      expect(fellThrough.warnings[0]).toContain(
        `Did not read ${override} into the Thread's instructions: `,
      );
      expect(fellThrough.warnings[0]).toContain("EACCES");

      chmodSync(agents, 0o000);
      const neither = provisionCapturingWarnings(CODEX, instanceHome, { HOME: home });

      expect(neither.material).toEqual(NO_USER_MATERIAL_PATHS);
      expect(neither.warnings).toHaveLength(2);
      expect(neither.warnings[1]).toContain(
        `Did not read ${agents} into the Thread's instructions: `,
      );
    },
  );
});

describe("pi's material", () => {
  it("lists only the directories that exist, and writes nothing", () => {
    const { home, instanceHome } = createHomes();
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });

    const material = provision(PI, instanceHome, { HOME: home });

    expect(material).toEqual({
      skillDirs: [join(home, ".agents", "skills")],
      promptTemplateDirs: [join(home, ".pi", "agent", "prompts")],
      instructionsFile: undefined,
    });
    expect(readdirSync(instanceHome)).toEqual([]);
  });

  it("lists the shared skills directory before pi's own", () => {
    const { home, instanceHome } = createHomes();
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });

    expect(provision(PI, instanceHome, { HOME: home }).skillDirs).toEqual([
      join(home, ".agents", "skills"),
      join(home, ".pi", "agent", "skills"),
    ]);
  });

  it("picks the instructions file in pi's precedence", () => {
    const { home, instanceHome } = createHomes();
    const agentDir = join(home, ".pi", "agent");
    const claude = writeFile(join(agentDir, "CLAUDE.md"));
    // The four names before it are missing, which is not worth a warning.
    expect(provisionCapturingWarnings(PI, instanceHome, { HOME: home })).toEqual({
      material: { ...NO_USER_MATERIAL_PATHS, instructionsFile: claude },
      warnings: [],
    });

    const agents = writeFile(join(agentDir, "AGENTS.md"));
    expect(provision(PI, instanceHome, { HOME: home }).instructionsFile).toBe(agents);

    const override = writeFile(join(agentDir, "AGENTS.override.md"));
    expect(provision(PI, instanceHome, { HOME: home }).instructionsFile).toBe(override);
  });

  it("skips a name that is not a regular file, as pi does", () => {
    const { home, instanceHome } = createHomes();
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(join(agentDir, "AGENTS.override.md"), { recursive: true });
    const agents = writeFile(join(agentDir, "AGENTS.md"));

    expect(provision(PI, instanceHome, { HOME: home }).instructionsFile).toBe(agents);
  });

  it.skipIf(RUNS_AS_ROOT)(
    "falls through a file it cannot read, as pi does, and logs a warning for it",
    () => {
      // pi would take the path of a file it cannot read as the instructions
      // text, so such a file must never be passed to it.
      const { home, instanceHome } = createHomes();
      const agentDir = join(home, ".pi", "agent");
      const agents = writeUnreadableFile(join(agentDir, "AGENTS.md"));
      const claude = writeFile(join(agentDir, "CLAUDE.md"), "be terse");

      const { material, warnings } = provisionCapturingWarnings(PI, instanceHome, { HOME: home });

      expect(material.instructionsFile).toBe(claude);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Did not read ${agents} into the Thread's instructions: `);
      expect(warnings[0]).toContain("EACCES");
    },
  );

  it("picks an empty file, as pi does", () => {
    const { home, instanceHome } = createHomes();
    const agentDir = join(home, ".pi", "agent");
    const agents = writeFile(join(agentDir, "AGENTS.md"), "");
    writeFile(join(agentDir, "CLAUDE.md"), "be terse");

    expect(provision(PI, instanceHome, { HOME: home }).instructionsFile).toBe(agents);
  });
});

describe("any other provider", () => {
  it("gets no material, and nothing is written", () => {
    const { home, instanceHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"));

    expect(provision("some-other-harness", instanceHome, { HOME: home })).toEqual(
      NO_USER_MATERIAL_PATHS,
    );
    expect(readdirSync(instanceHome)).toEqual([]);
  });
});
