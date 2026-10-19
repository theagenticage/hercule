/**
 * The setup `capture-composer-skills.ts` and `perf-composer-skills.ts` share:
 * a controller in a scratch Hercule Home, a Skill Library filled through
 * `hercule skill import`, and a scripted runner that lists a checkout's
 * skills. Each script opens its own threads afterwards. It runs on plain Node,
 * so its imports name the `.ts` file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PASSWORD,
  USERNAME,
  findCompiledBinary,
  runCli,
  startSetUpController,
  type Controller,
} from "../../../scripts/controller-process.ts";
import { connectFleet, type Fleet, type ThreadPlacement } from "./fleet.ts";
import type { ScriptedSkills } from "./scripted-runner.ts";

/** One skill a script seeds, with the description its row shows. */
export interface SeededSkill {
  readonly name: string;
  readonly description: string;
}

/** What a script gives `startSkillsWorld` to seed. */
export interface SkillsWorldOptions {
  /** Names the script in the scratch directory and the CLI login, such as `capture`. */
  readonly scriptName: string;
  /** The skills imported into the Skill Library. */
  readonly librarySkills: ReadonlyArray<SeededSkill>;
  /** The skills the runner lists from the checkout's `.agents/skills`. */
  readonly repositorySkills: ReadonlyArray<SeededSkill>;
  /** The name of the checkout, of its project, and of its repository. */
  readonly checkoutName: string;
}

/** A controller with the skills seeded and a runner that is ready to host threads. */
export interface SkillsWorld {
  readonly url: string;
  readonly fleet: Fleet;
  /** Where a thread opens: the runner and the checkout. */
  readonly placement: ThreadPlacement;
  /** The skills the runner lists, for a script that changes them and restores them. */
  readonly skills: ScriptedSkills;
  /** Disconnects the runner, stops the controller and deletes the scratch directory. */
  readonly cleanup: () => Promise<void>;
}

/** Writes one skill folder per entry into `parent`, for `hercule skill import`. */
function writeSkillFolders(parent: string, skills: ReadonlyArray<SeededSkill>): void {
  for (const { name, description } of skills) {
    const folder = join(parent, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n# ${name}\n\nSteps.\n`,
    );
  }
}

/**
 * Starts a controller in a scratch Home, imports `librarySkills` with the
 * compiled CLI, enlists a scripted runner that lists `repositorySkills`, and
 * files a project and a repository for the checkout. Returns once threads can
 * be placed on the runner.
 *
 * Fails when the compiled binary is missing or the login or the import
 * fails. When any step fails, it stops what it started and deletes the
 * scratch directory before it fails. When it returns, the caller owns
 * `cleanup`.
 */
export async function startSkillsWorld(options: SkillsWorldOptions): Promise<SkillsWorld> {
  const scratch = mkdtempSync(join(tmpdir(), `hercule-769-${options.scriptName}-`));
  let controller: Controller | undefined;
  let fleet: Fleet | undefined;
  const cleanup = async (): Promise<void> => {
    try {
      await fleet?.disconnectRunners();
    } finally {
      try {
        await controller?.stop();
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  };
  try {
    const home = join(scratch, "home");
    mkdirSync(home);
    controller = await startSetUpController({ home });
    fleet = await connectFleet(controller.url);

    const cliHome = join(scratch, "cli-home");
    const skillsFolder = join(scratch, "skills");
    mkdirSync(cliHome);
    writeSkillFolders(skillsFolder, options.librarySkills);
    const binary = findCompiledBinary();
    const login = await runCli(
      [
        "login",
        controller.url,
        "--username",
        USERNAME,
        "--password-stdin",
        "--name",
        `${options.scriptName}-769`,
      ],
      { home: cliHome, binary, stdin: PASSWORD },
    );
    if (login.code !== 0) throw new Error(`login failed:\n${login.stderr}`);
    const imported = await runCli(["skill", "import", skillsFolder], { home: cliHome, binary });
    if (imported.code !== 0) {
      throw new Error(`skill import failed:\n${imported.stdout}${imported.stderr}`);
    }

    const runner = await fleet.enlistRunner("studio-mac");
    const skills: ScriptedSkills = {
      repository: options.repositorySkills.map(({ name, description }) => ({
        checkoutName: options.checkoutName,
        name,
        description,
        path: `.agents/skills/${name}`,
      })),
      names: [
        ...options.librarySkills.map(({ name }) => name),
        ...options.repositorySkills.map(({ name }) => `${options.checkoutName}:${name}`),
      ],
    };
    runner.setSkills(skills);
    const project = await fleet.createProject(options.checkoutName);
    const repository = await fleet.createRepository(
      `https://github.com/acme/${options.checkoutName}`,
      [project.id],
    );
    return {
      url: controller.url,
      fleet,
      placement: {
        runner,
        projectId: project.id,
        workspace: { kind: "primary", resourceId: repository.id },
      },
      skills,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
