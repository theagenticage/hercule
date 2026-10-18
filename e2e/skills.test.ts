/**
 * Tests the Skill Library through the release binary, the way a user fills it
 * from a folder of skills with `hercule skill import`.
 *
 * The test builds its own folder of skills in a temporary directory, shaped
 * like the `~/.agents/skills` that the `skills` tool writes:
 *
 * - 24 skills, one of them (`grilling`) with `allowed-tools` in its
 *   `SKILL.md`, a second file and an executable script;
 * - `implement`, a symbolic link to a skill folder elsewhere;
 * - a `.skill-lock.json` beside the folder that gives three skills a GitHub
 *   source.
 *
 * Every command runs `./hercule` as a separate process against a controller
 * started from the same binary, so what is checked is what a shell sees: the
 * printed lines, the `--json` output and the exit code.
 *
 * ## What this test does not check
 *
 * That a session token is refused `skill.import`. The only way this harness
 * gets a session token is a live session, and `e2e/session-tool.test.ts`
 * explains why the test never takes the token out of one. The controller's
 * own tests of `skill.import` check the refusal instead.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  completeSetup,
  findCompiledBinary,
  runCli,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  createTemporaryHome,
  parseJsonOutput,
  parseJsonOutputOrFail,
  type Page,
  type TemporaryHome,
} from "./harness";

/** The 24 skills of the fixture folder, in the order the CLI imports them. */
const SKILL_NAMES = [
  "cio",
  "code-review",
  "codebase-design",
  "debug",
  "domain-modeling",
  "grill-me",
  "grill-with-docs",
  "grilling",
  "handoff",
  "herdr-gpui-browser",
  "implement",
  "improve-codebase-architecture",
  "playwright-cli",
  "prototype",
  "research",
  "review",
  "setup-matt-pocock-skills",
  "ship",
  "spec",
  "teach",
  "to-spec",
  "to-tickets",
  "triage",
  "wayfinder",
] as const;

/** The skills the lock file gives a GitHub source, by name, with the folder it names. */
const GITHUB_SKILLS: Readonly<Record<string, string>> = {
  grilling: "skills/productivity/grilling",
  "codebase-design": "skills/engineering/codebase-design",
  "domain-modeling": "skills/engineering/domain-modeling",
};

const GITHUB_REPO = "mattpocock/skills";

/** The warning line the CLI prints, indented, under every import of `grilling`. */
const GRILLING_WARNING = "  `grilling` lets tools run without asking: `Bash(git:*) Read`";

/** A skill as `skill.query` and `skill.import` return it; only the fields read here. */
interface SkillRow {
  readonly name: string;
  readonly source:
    | { readonly kind: "github"; readonly repo: string; readonly path: string }
    | { readonly kind: "upload" };
  readonly currentRevisionHash: string;
}

/** What `skill read --json` prints; only the fields read here. */
interface SkillDetail {
  readonly skill: SkillRow;
  readonly files: ReadonlyArray<{ readonly path: string; readonly mode: string }>;
  readonly history: ReadonlyArray<{ readonly revisionHash: string }>;
}

/** What `skill import --json` prints for each skill of a folder. */
interface SkillSentRow {
  readonly name: string;
  readonly result?: string;
  readonly error?: { readonly code?: string; readonly message: string };
}

let state: TemporaryHome;
/** The temporary directory that holds every fixture folder. */
let fixture: string;
/** The folder of 24 skills, as the `skills` tool lays it out. */
let skillsFolder: string;
let binary: string;
let controller: Controller;

/** Runs the CLI binary with the credential file the login wrote. */
const runLoggedInCli = (args: ReadonlyArray<string>, stdin?: string) =>
  runCli(args, { home: state.home, binary, stdin });

/** Returns a command's stdout as lines, without the empty line its final newline leaves. */
const splitLines = (ran: Ran): ReadonlyArray<string> => ran.stdout.trimEnd().split("\n");

/** Writes a file, creating the folders it sits in. */
const writeFixtureFile = (path: string, content: string | Uint8Array): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
};

/** Returns a `SKILL.md` with the frontmatter every skill needs, and any extra lines. */
const buildSkillMd = (name: string, extraFrontmatter: ReadonlyArray<string> = []): string =>
  [
    "---",
    `name: ${name}`,
    `description: What the ${name} skill does.`,
    ...extraFrontmatter,
    "---",
    `# ${name}`,
    "",
  ].join("\n");

/**
 * Builds the fixture folder of 24 skills and the lock file beside it, in the
 * layout of `~/.agents`: `<fixture>/agents/skills/<name>/` and
 * `<fixture>/agents/.skill-lock.json`. `implement` is a link to a folder
 * outside it, as `npx skills` makes them.
 */
const buildSkillsFolder = (): string => {
  const agents = join(fixture, "agents");
  const skills = join(agents, "skills");
  mkdirSync(skills, { recursive: true });
  for (const name of SKILL_NAMES) {
    if (name === "implement") continue;
    const extra = name === "grilling" ? ["allowed-tools: Bash(git:*) Read"] : [];
    writeFixtureFile(join(skills, name, "SKILL.md"), buildSkillMd(name, extra));
  }

  const grilling = join(skills, "grilling");
  writeFixtureFile(join(grilling, "references", "questions.md"), "# Questions\n");
  writeFixtureFile(join(grilling, "scripts", "check.sh"), "#!/bin/sh\necho checked\n");
  chmodSync(join(grilling, "scripts", "check.sh"), 0o755);
  // The reader skips this file, so it must not reach the archive.
  writeFixtureFile(join(grilling, ".DS_Store"), "finder state");

  const linkedTarget = join(fixture, "elsewhere", "implement");
  writeFixtureFile(join(linkedTarget, "SKILL.md"), buildSkillMd("implement"));
  symlinkSync(linkedTarget, join(skills, "implement"));

  const lockEntries = Object.fromEntries(
    Object.entries(GITHUB_SKILLS).map(([name, folder]) => [
      name,
      {
        source: GITHUB_REPO,
        sourceType: "github",
        sourceUrl: `https://github.com/${GITHUB_REPO}.git`,
        skillPath: `${folder}/SKILL.md`,
      },
    ]),
  );
  writeFixtureFile(
    join(agents, ".skill-lock.json"),
    JSON.stringify({ version: 3, skills: lockEntries }, null, 2),
  );
  return skills;
};

/** Returns the lines a folder import prints when every skill gets `result`. */
const buildImportLines = (result: string): ReadonlyArray<string> =>
  SKILL_NAMES.flatMap((name) =>
    name === "grilling" ? [`${name}: ${result}`, GRILLING_WARNING] : [`${name}: ${result}`],
  );

/** Reads one skill with `skill read --json`, failing with the command's output. */
const readSkill = async (name: string): Promise<SkillDetail> =>
  parseJsonOutputOrFail<SkillDetail>(await runLoggedInCli(["skill", "read", name, "--json"]));

beforeAll(async () => {
  binary = findCompiledBinary();
  state = createTemporaryHome();
  fixture = mkdtempSync(join(tmpdir(), "hercule-e2e-skills-"));
  skillsFolder = buildSkillsFolder();

  controller = await startController({ home: state.home, binary });
  const completed = await completeSetup({ home: state.home, url: controller.url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
  const login = await runLoggedInCli(
    ["login", controller.url, "--username", USERNAME, "--password-stdin", "--name", "e2e-skills"],
    PASSWORD,
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
}, 90_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state?.remove();
  if (fixture !== undefined) rmSync(fixture, { recursive: true, force: true });
});

describe("the Skill Library through `hercule skill`", () => {
  it("imports a folder of 24 skills, one line per skill and the warning under grilling", async () => {
    const imported = await runLoggedInCli(["skill", "import", skillsFolder]);
    expect(imported.code, imported.stderr).toBe(0);
    expect(splitLines(imported)).toEqual(buildImportLines("created"));

    const grilling = await readSkill("grilling");
    expect(grilling.skill.source).toEqual({
      kind: "github",
      repo: GITHUB_REPO,
      path: GITHUB_SKILLS["grilling"],
      branch: null,
    });
    // The skill behind the link imports with its target's content, under the link's name.
    const implement = await readSkill("implement");
    expect(implement.skill.source).toEqual({ kind: "upload" });
    expect(implement.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  }, 60_000);

  it("prints unchanged for every skill when the same folder is imported again", async () => {
    const before = await readSkill("grilling");
    const again = await runLoggedInCli(["skill", "import", skillsFolder]);
    expect(again.code, again.stderr).toBe(0);
    expect(splitLines(again)).toEqual(buildImportLines("unchanged"));
    // An unchanged import stores no revision.
    expect((await readSkill("grilling")).history).toEqual(before.history);
  }, 60_000);

  it("refuses a changed skill with a conflict naming both hashes, and revises it with --replace true", async () => {
    const before = await readSkill("grilling");
    writeFixtureFile(
      join(skillsFolder, "grilling", "SKILL.md"),
      buildSkillMd("grilling", ["allowed-tools: Bash(git:*) Read"]) +
        "Ask one question at a time.\n",
    );

    const refused = await runLoggedInCli(["skill", "import", skillsFolder, "--json"]);
    expect(refused.code).toBe(1);
    const sent = (parseJsonOutput(refused) as { skills: ReadonlyArray<SkillSentRow> }).skills;
    const grillingSent = sent.find((row) => row.name === "grilling");
    expect(grillingSent?.error?.code).toBe("conflict");
    const hashes = /current revision `([0-9a-f]{64})`, imported content `([0-9a-f]{64})`/.exec(
      grillingSent?.error?.message ?? "",
    );
    expect(hashes, grillingSent?.error?.message).not.toBeNull();
    const [, currentHash, importedHash] = hashes!;
    expect(currentHash).toBe(before.skill.currentRevisionHash);
    expect(importedHash).not.toBe(currentHash);
    expect(sent.filter((row) => row.name !== "grilling").map((row) => row.result)).toEqual(
      Array.from({ length: SKILL_NAMES.length - 1 }, () => "unchanged"),
    );

    const replaced = await runLoggedInCli(["skill", "import", skillsFolder, "--replace", "true"]);
    expect(replaced.code, replaced.stderr).toBe(0);
    expect(splitLines(replaced)).toEqual(
      SKILL_NAMES.flatMap((name) =>
        name === "grilling" ? ["grilling: revised", GRILLING_WARNING] : [`${name}: unchanged`],
      ),
    );
    expect((await readSkill("grilling")).skill.currentRevisionHash).toBe(importedHash);
  }, 60_000);

  it("reads grilling: its files with their modes, and a history of two revisions", async () => {
    const grilling = await readSkill("grilling");
    expect(grilling.files.map((file) => [file.path, file.mode])).toEqual([
      ["SKILL.md", "644"],
      ["references/questions.md", "644"],
      ["scripts/check.sh", "755"],
    ]);
    expect(grilling.history).toHaveLength(2);
    expect(grilling.history[0]?.revisionHash).toBe(grilling.skill.currentRevisionHash);

    const shown = await runLoggedInCli(["skill", "read", "grilling"]);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("scripts/check.sh");
    expect(shown.stdout).toContain("Ask one question at a time.");
  }, 30_000);

  it("deletes teach, after which the list shows the other 23 with their sources", async () => {
    const deleted = await runLoggedInCli(["skill", "delete", "teach"]);
    expect(deleted.code, deleted.stderr).toBe(0);
    const gone = await runLoggedInCli(["skill", "read", "teach", "--json"]);
    expect(gone.code).toBe(1);
    expect(parseJsonOutput(gone)).toMatchObject({ error: { code: "not_found" } });

    const listed = parseJsonOutputOrFail<Page<SkillRow>>(
      await runLoggedInCli(["skill", "list", "--json"]),
    ).items;
    expect(listed.map((skill) => skill.name)).toEqual(
      SKILL_NAMES.filter((name) => name !== "teach"),
    );
    for (const skill of listed) {
      const githubPath = GITHUB_SKILLS[skill.name];
      expect(skill.source, skill.name).toEqual(
        githubPath === undefined
          ? { kind: "upload" }
          : { kind: "github", repo: GITHUB_REPO, path: githubPath, branch: null },
      );
    }

    // The table has a header and one row per skill, in the order `--json` lists them.
    const table = await runLoggedInCli(["skill", "list"]);
    expect(table.code, table.stderr).toBe(0);
    const [header, ...rows] = splitLines(table);
    expect(header?.split(/\s+/)).toEqual(expect.arrayContaining(["name", "source"]));
    expect(rows.map((row) => row.split(/\s+/)[0])).toEqual(listed.map((skill) => skill.name));
    expect(rows.find((row) => row.startsWith("grilling "))).toContain(GITHUB_REPO);
  }, 30_000);

  it("refuses a skill whose link points outside its folder, naming the link, and imports the others", async () => {
    const folder = join(fixture, "with-escape");
    writeFixtureFile(join(fixture, "outside.txt"), "not the skill's\n");
    writeFixtureFile(join(folder, "escape", "SKILL.md"), buildSkillMd("escape"));
    symlinkSync(join(fixture, "outside.txt"), join(folder, "escape", "notes.md"));
    writeFixtureFile(join(folder, "fine", "SKILL.md"), buildSkillMd("fine"));

    const imported = await runLoggedInCli(["skill", "import", folder]);
    expect(imported.code).toBe(1);
    expect(splitLines(imported)).toEqual([
      "escape: refused: `escape/notes.md` points outside the skill's folder. A skill holds only its own files; copy what it needs into its folder.",
      "fine: created",
    ]);
    const escape = await runLoggedInCli(["skill", "read", "escape", "--json"]);
    expect(parseJsonOutput(escape)).toMatchObject({ error: { code: "not_found" } });
  }, 30_000);

  it("refuses a skill over 10 MiB in the CLI, before sending it", async () => {
    const folder = join(fixture, "oversized");
    writeFixtureFile(join(folder, "huge", "SKILL.md"), buildSkillMd("huge"));
    writeFixtureFile(join(folder, "huge", "blob.bin"), new Uint8Array(11 * 1024 * 1024));

    const imported = await runLoggedInCli(["skill", "import", folder, "--json"]);
    expect(imported.code).toBe(1);
    // A refusal from the controller would carry an error code; the CLI's own has none.
    expect(parseJsonOutput(imported)).toEqual({
      skills: [
        {
          name: "huge",
          error: { message: "`huge` is over 10 MiB, the most a skill can hold." },
        },
      ],
      stopped: null,
      lockFileProblem: null,
    });
    const huge = await runLoggedInCli(["skill", "read", "huge", "--json"]);
    expect(parseJsonOutput(huge)).toMatchObject({ error: { code: "not_found" } });
  }, 30_000);
});
