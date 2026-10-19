/**
 * Tests that the runner stages repository skills as plugin folders of
 * symlinks, on a temporary directory.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { stageRepositorySkills } from "./repository-staging";
import type { ListedRepositorySkill } from "./repository";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "hercule-staging-"));
  roots.push(root);
  return root;
};

/** Makes a skill folder in a checkout and returns the skill as the listing reports it. */
const makeSkill = (
  root: string,
  checkoutName: string,
  name: string,
  edited = "",
): ListedRepositorySkill => {
  const absolutePath = join(root, "checkouts", checkoutName, ".agents", "skills", name);
  mkdirSync(absolutePath, { recursive: true });
  writeFileSync(join(absolutePath, "SKILL.md"), `---\ndescription: ${name}\n---\n${edited}`);
  return {
    checkoutName,
    name,
    description: name,
    path: `${checkoutName}/.agents/skills/${name}`,
    absolutePath,
  };
};

describe("stageRepositorySkills", () => {
  it("writes one plugin per checkout, with a link per skill into the checkout", async () => {
    const root = makeRoot();
    const folder = join(root, "session-skills", "start-1");
    const skills = [
      makeSkill(root, "api", "build"),
      makeSkill(root, "api", "release"),
      makeSkill(root, "hercule", "deploy"),
    ];

    const pluginFolders = await Effect.runPromise(stageRepositorySkills(folder, skills));

    expect(pluginFolders).toEqual([
      join(folder, "repositories", "api"),
      join(folder, "repositories", "hercule"),
    ]);
    expect(
      JSON.parse(readFileSync(join(pluginFolders[0]!, ".claude-plugin", "plugin.json"), "utf8")),
    ).toEqual({ name: "repo-api" });
    expect(
      JSON.parse(readFileSync(join(pluginFolders[1]!, ".claude-plugin", "plugin.json"), "utf8")),
    ).toEqual({ name: "repo-hercule" });
    expect(readdirSync(join(pluginFolders[0]!, "skills")).sort()).toEqual(["build", "release"]);
    for (const skill of skills) {
      const link = join(folder, "repositories", skill.checkoutName, "skills", skill.name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(skill.absolutePath);
    }
  });

  it("shows an edit made in the checkout, because the skill is linked and not copied", async () => {
    const root = makeRoot();
    const folder = join(root, "start");
    const skill = makeSkill(root, "api", "build");
    await Effect.runPromise(stageRepositorySkills(folder, [skill]));

    writeFileSync(join(skill.absolutePath, "SKILL.md"), "edited");

    expect(
      readFileSync(join(folder, "repositories", "api", "skills", "build", "SKILL.md"), "utf8"),
    ).toBe("edited");
  });

  it("writes nothing for a workspace without repository skills", async () => {
    const root = makeRoot();
    const folder = join(root, "start");

    await expect(Effect.runPromise(stageRepositorySkills(folder, []))).resolves.toEqual([]);
    expect(existsSync(folder)).toBe(false);
  });

  it("fails with the reason when the folder cannot be written", async () => {
    const root = makeRoot();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "a file, not a folder");

    const failure = await Effect.runPromise(
      Effect.flip(stageRepositorySkills(blocker, [makeSkill(root, "api", "build")])),
    );

    expect(failure).toMatch(/^(ENOTDIR|EEXIST)/);
    expect(failure).not.toContain("could not stage");
  });
});
