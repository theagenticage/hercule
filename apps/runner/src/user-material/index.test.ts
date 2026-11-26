/**
 * Tests what a Thread sees of the user's own material. Every test builds a
 * fake user home in a temporary directory; none reads the real one. Besides
 * what each harness gets, the tests guard two things the spec names:
 *
 * - Codex and pi never get anything written into their Harness Home, which
 *   every session of the account shares;
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
import { ANTIGRAVITY, CLAUDE_CODE, CODEX, PI } from "../harnesses";
import { cleanupHomes, createScratchHome, NO_USER_MATERIAL } from "../harnesses/testing";
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

/** Creates an empty fake user home and an empty Harness Home. */
const createHomes = (): { readonly home: string; readonly harnessHome: string } => ({
  home: createScratchHome("user"),
  harnessHome: createScratchHome("harness-home"),
});

/**
 * Provisions the user's material for one Thread and returns the material and
 * every warning logged while doing so.
 */
const provisionCapturingWarnings = (
  harnessId: string,
  harnessHome: string,
  env: Record<string, string>,
) => {
  const warnings: Array<string> = [];
  const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });
  const material = Effect.runSync(
    Effect.provide(provisionUserMaterial(harnessId, harnessHome, env), Logger.layer([collecting])),
  );
  return { material, warnings };
};

/** Provisions the user's material for one Thread and returns the material. */
const provision = (harnessId: string, harnessHome: string, env: Record<string, string>) =>
  provisionCapturingWarnings(harnessId, harnessHome, env).material;

describe("Claude Code's material", () => {
  it("links each entry of the user's .claude directory that exists, and only those", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"), "be terse");
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });

    const material = provision(CLAUDE_CODE, harnessHome, { HOME: home });

    // Claude reads its material from the Harness Home, so it needs no paths.
    expect(material).toEqual(NO_USER_MATERIAL);
    expect(readdirSync(harnessHome).sort()).toEqual(["CLAUDE.md", "agents"]);
    expect(readlinkSync(join(harnessHome, "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
    expect(readFileSync(join(harnessHome, "CLAUDE.md"), "utf8")).toBe("be terse");
  });

  it("resolves a relative symlink inside a linked directory, as it does for the user", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, "dotfiles", "agents", "reviewer.md"), "# reviewer");
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    // What a dotfiles manager makes: a relative link into another directory.
    symlinkSync(
      "../../dotfiles/agents/reviewer.md",
      join(home, ".claude", "agents", "reviewer.md"),
    );

    provision(CLAUDE_CODE, harnessHome, { HOME: home });

    expect(readFileSync(join(harnessHome, "agents", "reviewer.md"), "utf8")).toBe("# reviewer");
  });

  it("leaves a correct link as it is on a second start, with no temporary link left behind", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"));
    provision(CLAUDE_CODE, harnessHome, { HOME: home });

    provision(CLAUDE_CODE, harnessHome, { HOME: home });

    expect(readdirSync(harnessHome)).toEqual(["CLAUDE.md"]);
    expect(readlinkSync(join(harnessHome, "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
  });

  it("removes a link whose source the user has removed, so it does not dangle", () => {
    const { home, harnessHome } = createHomes();
    const source = writeFile(join(home, ".claude", "CLAUDE.md"));
    provision(CLAUDE_CODE, harnessHome, { HOME: home });
    rmSync(source);

    provision(CLAUDE_CODE, harnessHome, { HOME: home });

    expect(readdirSync(harnessHome)).toEqual([]);
  });

  it("repoints a stale link at the user's entry", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"), "the user's");
    symlinkSync(writeFile(join(home, "elsewhere.md"), "stale"), join(harnessHome, "CLAUDE.md"));

    provision(CLAUDE_CODE, harnessHome, { HOME: home });

    expect(readlinkSync(join(harnessHome, "CLAUDE.md"))).toBe(join(home, ".claude", "CLAUDE.md"));
    expect(readFileSync(join(harnessHome, "CLAUDE.md"), "utf8")).toBe("the user's");
  });

  it("never replaces a real file or directory in the Harness Home, and logs a warning for each", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"), "the user's");
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    writeFile(join(harnessHome, "CLAUDE.md"), "already here");
    writeFile(join(harnessHome, "agents", "own.md"), "already here");

    const { material, warnings } = provisionCapturingWarnings(CLAUDE_CODE, harnessHome, {
      HOME: home,
    });

    expect(material).toEqual(NO_USER_MATERIAL);
    expect(warnings).toEqual([
      expect.stringContaining(`${join(harnessHome, "agents")} already exists and is not a symlink`),
      expect.stringContaining(
        `${join(harnessHome, "CLAUDE.md")} already exists and is not a symlink`,
      ),
    ]);
    expect(lstatSync(join(harnessHome, "CLAUDE.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(harnessHome, "CLAUDE.md"), "utf8")).toBe("already here");
    expect(lstatSync(join(harnessHome, "agents")).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(harnessHome, "agents"))).toEqual(["own.md"]);
  });

  it("does not link the user's skills, which come from the Skill Library", () => {
    const { home, harnessHome } = createHomes();
    mkdirSync(join(home, ".claude", "skills", "implement"), { recursive: true });

    provision(CLAUDE_CODE, harnessHome, { HOME: home });

    expect(readdirSync(harnessHome)).toEqual([]);
  });

  it("removes the skills link an earlier runner made in the Harness Home", () => {
    const { home, harnessHome } = createHomes();
    mkdirSync(join(home, ".claude", "skills", "implement"), { recursive: true });
    symlinkSync(join(home, ".claude", "skills"), join(harnessHome, "skills"));

    provision(CLAUDE_CODE, harnessHome, { HOME: home });

    expect(readdirSync(harnessHome)).toEqual([]);
    // Only the link went: the user's skills are untouched.
    expect(readdirSync(join(home, ".claude", "skills"))).toEqual(["implement"]);
  });

  it("keeps a real skills directory, or a skills link that points elsewhere, in the Harness Home", () => {
    const { home, harnessHome } = createHomes();
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    writeFile(join(harnessHome, "skills", "own", "SKILL.md"), "already here");
    const other = createHomes();
    const elsewhere = join(home, "elsewhere-skills");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(other.harnessHome, "skills"));

    provision(CLAUDE_CODE, harnessHome, { HOME: home });
    provision(CLAUDE_CODE, other.harnessHome, { HOME: home });

    expect(lstatSync(join(harnessHome, "skills")).isSymbolicLink()).toBe(false);
    expect(readdirSync(join(harnessHome, "skills"))).toEqual(["own"]);
    expect(readlinkSync(join(other.harnessHome, "skills"))).toBe(elsewhere);
  });

  it("returns empty paths and does not fail when a link cannot be made, and logs a warning", () => {
    const { home } = createHomes();
    const source = writeFile(join(home, ".claude", "CLAUDE.md"));
    // A file where the Harness Home should be: every link fails with ENOTDIR.
    const notADirectory = writeFile(join(home, "not-a-directory"), "untouched");

    const { material, warnings } = provisionCapturingWarnings(CLAUDE_CODE, notADirectory, {
      HOME: home,
    });

    expect(material).toEqual(NO_USER_MATERIAL);
    expect(readFileSync(notADirectory, "utf8")).toBe("untouched");
    // Only the entry the user has is worth a warning, not the four they lack.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Did not link ${source} into the Thread: `);
    expect(warnings[0]).toContain("ENOTDIR");
  });

  it("links nothing when the runner has no HOME", () => {
    const { harnessHome } = createHomes();

    expect(provision(CLAUDE_CODE, harnessHome, {})).toEqual(NO_USER_MATERIAL);
    expect(readdirSync(harnessHome)).toEqual([]);
  });
});

describe("Codex's material", () => {
  it("prefers AGENTS.override.md over AGENTS.md, and writes nothing", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".codex", "AGENTS.md"), "The agents file.");
    writeFile(join(home, ".codex", "AGENTS.override.md"), "The override.");

    const material = provision(CODEX, harnessHome, { HOME: home });

    expect(material).toEqual({ ...NO_USER_MATERIAL, instructions: "The override." });
    // Every session of the account shares its home; a link there would leak.
    expect(readdirSync(harnessHome)).toEqual([]);
  });

  it("reads AGENTS.md when there is no override, and nothing when there is neither", () => {
    const { home, harnessHome } = createHomes();
    // A missing file is the normal case, not worth a warning.
    expect(provisionCapturingWarnings(CODEX, harnessHome, { HOME: home })).toEqual({
      material: NO_USER_MATERIAL,
      warnings: [],
    });

    writeFile(join(home, ".codex", "AGENTS.md"), "The agents file.");

    expect(provision(CODEX, harnessHome, { HOME: home }).instructions).toBe("The agents file.");
  });

  it("reads the Codex home from CODEX_HOME when the runner has it set", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".codex", "AGENTS.md"), "Under HOME.");
    const elsewhere = createScratchHome("codex-home");
    writeFile(join(elsewhere, "AGENTS.md"), "Under CODEX_HOME.");

    expect(provision(CODEX, harnessHome, { HOME: home, CODEX_HOME: elsewhere }).instructions).toBe(
      "Under CODEX_HOME.",
    );
    expect(readdirSync(harnessHome)).toEqual([]);
  });

  it("reads the .codex directory under HOME when CODEX_HOME is set but empty", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".codex", "AGENTS.md"), "Under HOME.");

    expect(provision(CODEX, harnessHome, { HOME: home, CODEX_HOME: "" }).instructions).toBe(
      "Under HOME.",
    );
  });

  it("falls through to AGENTS.md when the override holds only white space or is not a file", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".codex", "AGENTS.md"), "The agents file.");
    const override = writeFile(join(home, ".codex", "AGENTS.override.md"), "");
    expect(provision(CODEX, harnessHome, { HOME: home }).instructions).toBe("The agents file.");

    writeFileSync(override, "  \n\n");
    expect(provision(CODEX, harnessHome, { HOME: home }).instructions).toBe("The agents file.");

    rmSync(override);
    mkdirSync(override);
    expect(provision(CODEX, harnessHome, { HOME: home }).instructions).toBe("The agents file.");
  });

  it.skipIf(RUNS_AS_ROOT)(
    "falls through a file it cannot read, as Codex does, and logs a warning for it",
    () => {
      const { home, harnessHome } = createHomes();
      const agents = writeFile(join(home, ".codex", "AGENTS.md"), "be terse");
      const override = writeUnreadableFile(join(home, ".codex", "AGENTS.override.md"));

      const fellThrough = provisionCapturingWarnings(CODEX, harnessHome, { HOME: home });

      expect(fellThrough.material.instructions).toBe("be terse");
      expect(fellThrough.warnings).toHaveLength(1);
      expect(fellThrough.warnings[0]).toContain(
        `Did not read ${override} into the Thread's instructions: `,
      );
      expect(fellThrough.warnings[0]).toContain("EACCES");

      chmodSync(agents, 0o000);
      const neither = provisionCapturingWarnings(CODEX, harnessHome, { HOME: home });

      expect(neither.material).toEqual(NO_USER_MATERIAL);
      expect(neither.warnings).toHaveLength(2);
      expect(neither.warnings[1]).toContain(
        `Did not read ${agents} into the Thread's instructions: `,
      );
    },
  );

  it("reads at most 64 KiB of the file and warns how much it left out", () => {
    const { home, harnessHome } = createHomes();
    const agents = writeFile(
      join(home, ".codex", "AGENTS.md"),
      `${"a".repeat(64 * 1024)}${"b".repeat(1000)}`,
    );

    const { material, warnings } = provisionCapturingWarnings(CODEX, harnessHome, { HOME: home });

    expect(material.instructions).toBe("a".repeat(64 * 1024));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Cut ${agents} `);
    expect(warnings[0]).toContain("left out the last 1000 of its 66536 bytes");
  });

  it("skips a named pipe, which would block a read", () => {
    const { home, harnessHome } = createHomes();
    mkdirSync(join(home, ".codex"), { recursive: true });
    Bun.spawnSync(["mkfifo", join(home, ".codex", "AGENTS.override.md")]);
    writeFile(join(home, ".codex", "AGENTS.md"), "The agents file.");

    expect(provisionCapturingWarnings(CODEX, harnessHome, { HOME: home })).toEqual({
      material: { ...NO_USER_MATERIAL, instructions: "The agents file." },
      warnings: [],
    });
  });

  it("writes a control character of a path into a warning escaped", () => {
    const { home, harnessHome } = createHomes();
    // A link to itself: a stat of it fails with ELOOP, which is not a missing file.
    const codexHome = join(home, "forged\nWARN fake line");
    mkdirSync(codexHome);
    symlinkSync(join(codexHome, "AGENTS.md"), join(codexHome, "AGENTS.md"));

    const { warnings } = provisionCapturingWarnings(CODEX, harnessHome, {
      HOME: home,
      CODEX_HOME: codexHome,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("\n");
    expect(warnings[0]).toContain("forged\\u{a}WARN fake line");
  });
});

describe("pi's material", () => {
  it("lists the prompt templates directory, leaves out the user's skills, and writes nothing", () => {
    const { home, harnessHome } = createHomes();
    // A Thread's skills come from the Skill Library, so neither skills
    // directory is passed to pi, even when both exist.
    mkdirSync(join(home, ".agents", "skills"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "skills"), { recursive: true });
    mkdirSync(join(home, ".pi", "agent", "prompts"), { recursive: true });

    const material = provision(PI, harnessHome, { HOME: home });

    expect(material).toEqual({
      ...NO_USER_MATERIAL,
      promptTemplateDirs: [join(home, ".pi", "agent", "prompts")],
    });
    expect(readdirSync(harnessHome)).toEqual([]);
  });

  it("picks the instructions file in pi's precedence", () => {
    const { home, harnessHome } = createHomes();
    const agentDir = join(home, ".pi", "agent");
    const claude = writeFile(join(agentDir, "CLAUDE.md"));
    // The four names before it are missing, which is not worth a warning.
    expect(provisionCapturingWarnings(PI, harnessHome, { HOME: home })).toEqual({
      material: { ...NO_USER_MATERIAL, instructionsFile: claude },
      warnings: [],
    });

    const agents = writeFile(join(agentDir, "AGENTS.md"));
    expect(provision(PI, harnessHome, { HOME: home }).instructionsFile).toBe(agents);

    const override = writeFile(join(agentDir, "AGENTS.override.md"));
    expect(provision(PI, harnessHome, { HOME: home }).instructionsFile).toBe(override);
  });

  it("skips a name that is not a regular file, as pi does", () => {
    const { home, harnessHome } = createHomes();
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(join(agentDir, "AGENTS.override.md"), { recursive: true });
    const agents = writeFile(join(agentDir, "AGENTS.md"));

    expect(provision(PI, harnessHome, { HOME: home }).instructionsFile).toBe(agents);
  });

  it.skipIf(RUNS_AS_ROOT)(
    "falls through a file it cannot read, as pi does, and logs a warning for it",
    () => {
      // pi would take the path of a file it cannot read as the instructions
      // text, so such a file must never be passed to it.
      const { home, harnessHome } = createHomes();
      const agentDir = join(home, ".pi", "agent");
      const agents = writeUnreadableFile(join(agentDir, "AGENTS.md"));
      const claude = writeFile(join(agentDir, "CLAUDE.md"), "be terse");

      const { material, warnings } = provisionCapturingWarnings(PI, harnessHome, { HOME: home });

      expect(material.instructionsFile).toBe(claude);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Did not read ${agents} into the Thread's instructions: `);
      expect(warnings[0]).toContain("EACCES");
    },
  );

  it("picks an empty file, as pi does", () => {
    const { home, harnessHome } = createHomes();
    const agentDir = join(home, ".pi", "agent");
    const agents = writeFile(join(agentDir, "AGENTS.md"), "");
    writeFile(join(agentDir, "CLAUDE.md"), "be terse");

    expect(provision(PI, harnessHome, { HOME: home }).instructionsFile).toBe(agents);
  });

  it("skips a named pipe, which would block a read", () => {
    const { home, harnessHome } = createHomes();
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    Bun.spawnSync(["mkfifo", join(agentDir, "AGENTS.override.md")]);
    const agents = writeFile(join(agentDir, "AGENTS.md"));

    expect(provision(PI, harnessHome, { HOME: home }).instructionsFile).toBe(agents);
  });
});

describe("Antigravity's material", () => {
  const ALWAYS_ON = "---\ntrigger: always_on\n---\nAlways follow this.\n";

  it("returns the text of every instructions file in Antigravity's order, and writes nothing", () => {
    const { home, harnessHome } = createHomes();
    const gemini = join(home, ".gemini");
    // Written in a different order than the one expected back.
    writeFile(join(gemini, "config", "rules", "style.md"), ALWAYS_ON);
    writeFile(join(gemini, "config", "AGENTS.md"), "config agents");
    writeFile(join(gemini, "AGENTS.md"), "agents");
    writeFile(join(gemini, "config", "GEMINI.md"), "config gemini");
    writeFile(join(gemini, "GEMINI.md"), "gemini");
    // Antigravity does not read this folder.
    writeFile(join(gemini, "antigravity-acp", "GEMINI.md"), "not read");

    const material = provision(ANTIGRAVITY, harnessHome, { HOME: home });

    expect(material).toEqual({
      ...NO_USER_MATERIAL,
      instructions: "gemini\n\nagents\n\nconfig gemini\n\nconfig agents\n\nAlways follow this.\n",
    });
    // Every session of the account shares its home; a link there would leak.
    expect(readdirSync(harnessHome)).toEqual([]);
  });

  it("returns only the files the user has, and nothing when there are none", () => {
    const { home, harnessHome } = createHomes();
    expect(provisionCapturingWarnings(ANTIGRAVITY, harnessHome, { HOME: home })).toEqual({
      material: NO_USER_MATERIAL,
      warnings: [],
    });

    writeFile(join(home, ".gemini", "config", "AGENTS.md"), "config agents");
    writeFile(join(home, ".gemini", "GEMINI.md"), "gemini");

    expect(provision(ANTIGRAVITY, harnessHome, { HOME: home }).instructions).toBe(
      "gemini\n\nconfig agents",
    );
  });

  it("leaves out a file with only white space", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".gemini", "GEMINI.md"), "  \n");
    writeFile(join(home, ".gemini", "AGENTS.md"), "Be terse.");

    expect(provision(ANTIGRAVITY, harnessHome, { HOME: home }).instructions).toBe("Be terse.");
  });

  it("keeps only the rules that are always on, sorted by file name, and without their frontmatter", () => {
    const { home, harnessHome } = createHomes();
    const rules = join(home, ".gemini", "config", "rules");
    writeFile(join(rules, "b-rule.md"), "---\ntrigger: always_on\n---\nSecond.\n");
    writeFile(join(rules, "B-first.md"), "---\ntrigger: always_on\n---\nFirst.\n");
    writeFile(join(rules, "manual.md"), "---\ntrigger: manual\n---\nOnly when asked.\n");
    writeFile(join(rules, "plain.md"), "No frontmatter here.\n");
    writeFile(join(rules, "broken.md"), "---\ntrigger: [always_on\n---\nBroken.\n");
    writeFile(join(rules, "quoted.md"), '---\ntrigger: "always_on"\n---\nQuoted.\n');
    writeFile(join(rules, "unclosed.md"), "---\ntrigger: always_on\nUnclosed.\n");
    writeFile(join(rules, "notes.txt"), ALWAYS_ON);
    // An always-on rule with nothing after its frontmatter has nothing to add.
    writeFile(join(rules, "empty.md"), "---\ntrigger: always_on\n---\n");
    mkdirSync(join(rules, "folder.md"), { recursive: true });

    const { material, warnings } = provisionCapturingWarnings(ANTIGRAVITY, harnessHome, {
      HOME: home,
    });

    // Uppercase sorts before lowercase in byte order.
    // Each text ends in a line break, and the texts are joined by a blank line.
    expect(material.instructions).toBe("First.\n\n\nSecond.\n\n\nQuoted.\n");
    // A rule Antigravity would not load is not worth a warning.
    expect(warnings).toEqual([]);
  });

  it("finds the frontmatter of a rule in its first 64 KiB only, and reads no more of it", () => {
    const { home, harnessHome } = createHomes();
    const rules = join(home, ".gemini", "config", "rules");
    const file = join(rules, "small.md");
    writeFile(file, `---\ntrigger: always_on\n---\n${"x".repeat(200_000)}`);
    writeFile(
      join(rules, "wide.md"),
      `---\nnotes: ${"x".repeat(70_000)}\ntrigger: always_on\n---\nWide.\n`,
    );

    const { material, warnings } = provisionCapturingWarnings(ANTIGRAVITY, harnessHome, {
      HOME: home,
    });

    // The first 64 KiB include the 27 bytes of frontmatter.
    expect(material.instructions).toBe("x".repeat(64 * 1024 - 27));
    expect(warnings).toEqual([expect.stringContaining(`Cut ${file} `)]);
  });

  it("checks no more than 100 rule files and warns once about the rest", () => {
    const { home, harnessHome } = createHomes();
    const rules = join(home, ".gemini", "config", "rules");
    for (let index = 0; index < 101; index += 1) {
      const name = `rule-${String(index).padStart(3, "0")}`;
      writeFile(join(rules, `${name}.md`), `---\ntrigger: always_on\n---\n${name}\n`);
    }

    const { material, warnings } = provisionCapturingWarnings(ANTIGRAVITY, harnessHome, {
      HOME: home,
    });

    expect(material.instructions?.match(/rule-\d{3}/g)).toHaveLength(100);
    expect(material.instructions).not.toContain("rule-100");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("101 entries");
  });

  it("returns a file once when another name links to it, at its first place", () => {
    const { home, harnessHome } = createHomes();
    const gemini = join(home, ".gemini");
    const geminiFile = writeFile(join(gemini, "GEMINI.md"), "gemini");
    symlinkSync(geminiFile, join(gemini, "AGENTS.md"));
    const configAgents = writeFile(join(gemini, "config", "AGENTS.md"), "config agents");
    const rules = join(gemini, "config", "rules");
    mkdirSync(rules, { recursive: true });
    symlinkSync(configAgents, join(rules, "linked.md"));
    writeFile(join(rules, "own.md"), ALWAYS_ON);

    expect(provision(ANTIGRAVITY, harnessHome, { HOME: home }).instructions).toBe(
      "gemini\n\nconfig agents\n\nAlways follow this.\n",
    );
  });

  it("reads at most 64 KiB of a file, and warns how much it left out", () => {
    const { home, harnessHome } = createHomes();
    const geminiFile = writeFile(
      join(home, ".gemini", "GEMINI.md"),
      `${"a".repeat(64 * 1024)}${"b".repeat(1000)}`,
    );

    const { material, warnings } = provisionCapturingWarnings(ANTIGRAVITY, harnessHome, {
      HOME: home,
    });

    expect(material.instructions).toBe("a".repeat(64 * 1024));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Cut ${geminiFile} `);
    expect(warnings[0]).toContain("left out the last 1000 of its 66536 bytes");
  });

  it("takes at most 256 KiB from all files, and leaves out the files that do not fit with a warning", () => {
    const { home, harnessHome } = createHomes();
    const gemini = join(home, ".gemini");
    writeFile(join(gemini, "GEMINI.md"), "g".repeat(64 * 1024));
    writeFile(join(gemini, "AGENTS.md"), "a".repeat(64 * 1024));
    writeFile(join(gemini, "config", "GEMINI.md"), "c".repeat(64 * 1024));
    writeFile(join(gemini, "config", "AGENTS.md"), "d".repeat(64 * 1024));
    const rule = writeFile(join(gemini, "config", "rules", "late.md"), ALWAYS_ON);
    // A rule that is not always on is not read into the instructions, so it is no news.
    writeFile(join(gemini, "config", "rules", "manual.md"), "---\ntrigger: manual\n---\nNo.\n");

    const { material, warnings } = provisionCapturingWarnings(ANTIGRAVITY, harnessHome, {
      HOME: home,
    });

    expect(material.instructions).toBe(
      ["g", "a", "c", "d"].map((letter) => letter.repeat(64 * 1024)).join("\n\n"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Left ${rule} out of the Thread's instructions`);
  });

  it("skips a named pipe, which would block a read", () => {
    const { home, harnessHome } = createHomes();
    mkdirSync(join(home, ".gemini"), { recursive: true });
    Bun.spawnSync(["mkfifo", join(home, ".gemini", "GEMINI.md")]);
    writeFile(join(home, ".gemini", "AGENTS.md"), "agents");

    expect(provisionCapturingWarnings(ANTIGRAVITY, harnessHome, { HOME: home })).toEqual({
      material: { ...NO_USER_MATERIAL, instructions: "agents" },
      warnings: [],
    });
  });

  it.skipIf(RUNS_AS_ROOT)(
    "skips a file it cannot read and logs a warning, for a rule and for a fixed file alike",
    () => {
      const { home, harnessHome } = createHomes();
      const gemini = join(home, ".gemini");
      const unreadable = writeUnreadableFile(join(gemini, "GEMINI.md"));
      writeFile(join(gemini, "AGENTS.md"), "agents");
      const rule = join(gemini, "config", "rules", "locked.md");
      writeUnreadableFile(rule);

      const { material, warnings } = provisionCapturingWarnings(ANTIGRAVITY, harnessHome, {
        HOME: home,
      });

      expect(material.instructions).toBe("agents");
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain(`Did not read ${unreadable} into the Thread's instructions: `);
      expect(warnings[1]).toContain(`Did not read ${rule} into the Thread's instructions: `);
    },
  );

  it("warns about a path that cannot be looked at, and still returns the others", () => {
    const { home, harnessHome } = createHomes();
    const gemini = join(home, ".gemini");
    const rules = join(gemini, "config", "rules");
    // A link to itself: a stat of it fails with ELOOP, which is not a missing file.
    mkdirSync(rules, { recursive: true });
    symlinkSync(join(gemini, "GEMINI.md"), join(gemini, "GEMINI.md"));
    symlinkSync(join(rules, "loop.md"), join(rules, "loop.md"));
    writeFile(join(gemini, "AGENTS.md"), "agents");
    writeFile(join(rules, "ok.md"), ALWAYS_ON);

    const { material, warnings } = provisionCapturingWarnings(ANTIGRAVITY, harnessHome, {
      HOME: home,
    });

    expect(material.instructions).toBe("agents\n\nAlways follow this.\n");
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(`Did not read ${join(gemini, "GEMINI.md")} into the Thread's`);
    expect(warnings[0]).toContain("ELOOP");
    expect(warnings[1]).toContain(`Did not read ${join(rules, "loop.md")} into the Thread's`);
  });

  it("writes a control character of a file name into a warning escaped", () => {
    const { home, harnessHome } = createHomes();
    const rules = join(home, ".gemini", "config", "rules");
    mkdirSync(rules, { recursive: true });
    const name = join(rules, "forged\nWARN fake line.md");
    symlinkSync(name, name);

    const { warnings } = provisionCapturingWarnings(ANTIGRAVITY, harnessHome, { HOME: home });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("\n");
    expect(warnings[0]).toContain("forged\\u{a}WARN fake line.md");
  });
});

describe("any other harness", () => {
  it("gets no material, and nothing is written", () => {
    const { home, harnessHome } = createHomes();
    writeFile(join(home, ".claude", "CLAUDE.md"));

    expect(provision("some-other-harness", harnessHome, { HOME: home })).toEqual(NO_USER_MATERIAL);
    expect(readdirSync(harnessHome)).toEqual([]);
  });
});
