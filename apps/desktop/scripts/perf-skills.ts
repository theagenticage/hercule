/**
 * The desktop perf script's Skills seed: fills the fixture's controller with
 * `SKILL_COUNT` skills through `hercule skill import`, the way a user fills
 * the Skill Library from a folder, and times one import of
 * `TIMED_IMPORT_SKILLS` of them.
 *
 * Each skill has a `SKILL.md` of a few paragraphs and one reference file, so
 * a skill's page draws its `SKILL.md`, its files and a History of one
 * revision. The CLI runs with a credential of its own, in a scratch home that
 * is deleted afterwards, because the fixture's Home holds the controller's
 * state and no CLI login.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PASSWORD,
  USERNAME,
  findCompiledBinary,
  runCli,
} from "../../../scripts/controller-process.ts";
import type { ThreadFixture } from "./perf-fixture.ts";

/** How many skills the Skill Library holds while Settings › Skills is measured. */
export const SKILL_COUNT = 100;

/** How many skills the timed import sends: the size of a typical `~/.agents/skills`. */
export const TIMED_IMPORT_SKILLS = 24;

/** The skills, and how long the timed import took. */
export interface SeededSkills {
  /** The name of every skill, in the order the list shows them. */
  readonly names: ReadonlyArray<string>;
  /** How long `hercule skill import` took to send `TIMED_IMPORT_SKILLS` new skills, in milliseconds. */
  readonly timedImportMs: number;
}

/** Returns the name of skill number `index`, counted from 1, padded so the names sort in order. */
const buildSkillName = (index: number): string => `perf-skill-${String(index).padStart(3, "0")}`;

/** Writes the folder of the skill named `name` into `parent`. */
function writeSkillFolder(parent: string, name: string): void {
  const folder = join(parent, name);
  mkdirSync(join(folder, "references"), { recursive: true });
  writeFileSync(
    join(folder, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: Reviews a change the way the team does, step ${name.slice(-3)}.`,
      "---",
      `# ${name}`,
      "",
      "Read the change once from top to bottom before you comment on any line.",
      "",
      "## Steps",
      "",
      "1. Check that the tests cover the change.",
      "2. Check the names against `GLOSSARY.md`.",
      "3. Write one comment per finding, and say why it matters.",
      "",
      "See [the checklist](references/checklist.md) for the details.",
      "",
    ].join("\n"),
  );
  writeFileSync(join(folder, "references", "checklist.md"), "# Checklist\n\n- Tests\n- Names\n");
}

/**
 * Runs `hercule skill import` on `folder` against the fixture's controller,
 * with the credential in `cliHome`, and returns how long it took in
 * milliseconds. Fails with the command's output when it exits with an error.
 */
async function importSkills(cliHome: string, folder: string): Promise<number> {
  const startedAt = performance.now();
  const ran = await runCli(["skill", "import", folder], {
    home: cliHome,
    binary: findCompiledBinary(),
  });
  const tookMs = performance.now() - startedAt;
  if (ran.code !== 0) {
    throw new Error(`skill import exited with ${String(ran.code)}:\n${ran.stdout}\n${ran.stderr}`);
  }
  return tookMs;
}

/**
 * Imports `SKILL_COUNT` new skills into the fixture's controller with the
 * compiled CLI, in two imports: first `TIMED_IMPORT_SKILLS`, which is timed,
 * then the rest. Returns the skills' names and the timed import's duration.
 * Fails when the login or an import fails. The scratch folders and the CLI's
 * home are deleted either way.
 */
export async function seedSkills(fixture: ThreadFixture): Promise<SeededSkills> {
  const scratch = mkdtempSync(join(tmpdir(), "hercule-desktop-perf-skills-"));
  try {
    const cliHome = join(scratch, "home");
    const timedFolder = join(scratch, "timed");
    const restFolder = join(scratch, "rest");
    mkdirSync(cliHome);
    const names = Array.from({ length: SKILL_COUNT }, (_, index) => buildSkillName(index + 1));
    for (const [index, name] of names.entries()) {
      writeSkillFolder(index < TIMED_IMPORT_SKILLS ? timedFolder : restFolder, name);
    }

    const login = await runCli(
      ["login", fixture.url, "--username", USERNAME, "--password-stdin", "--name", "perf-skills"],
      { home: cliHome, binary: findCompiledBinary(), stdin: PASSWORD },
    );
    if (login.code !== 0) {
      throw new Error(`login exited with ${String(login.code)}:\n${login.stderr}`);
    }
    const timedImportMs = await importSkills(cliHome, timedFolder);
    await importSkills(cliHome, restFolder);
    return { names, timedImportMs };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
