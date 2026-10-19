/**
 * Tests the bounds of the skill folder check on a temporary directory. The
 * rules about links and second skills are tested through the listing, in
 * `repository.test.ts`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MAX_SKILL_FOLDER_DEPTH,
  MAX_SKILL_FOLDER_ENTRIES,
  findSkillFolderProblem,
} from "./skill-folder";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Makes a checkout holding an empty skill folder, and returns both paths. */
const makeCheckout = (): { checkout: string; skill: string } => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), "hercule-skill-folder-")));
  roots.push(checkout);
  const skill = join(checkout, ".agents/skills/app");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\ndescription: A\n---\n");
  return { checkout, skill };
};

describe("findSkillFolderProblem", () => {
  it("accepts a folder with files, folders and a link to a file in the checkout", async () => {
    const { checkout, skill } = makeCheckout();
    mkdirSync(join(skill, "scripts"));
    writeFileSync(join(skill, "scripts/run.sh"), "echo");
    writeFileSync(join(checkout, "shared.md"), "x");
    symlinkSync(join(checkout, "shared.md"), join(skill, "shared.md"));

    await expect(findSkillFolderProblem(skill, checkout)).resolves.toBeUndefined();
  });

  it("accepts folders down to the depth limit and refuses the next level", async () => {
    const { checkout, skill } = makeCheckout();
    const levels = Array.from(
      { length: MAX_SKILL_FOLDER_DEPTH },
      (_, level) => `d${String(level)}`,
    );
    mkdirSync(join(skill, ...levels), { recursive: true });
    await expect(findSkillFolderProblem(skill, checkout)).resolves.toBeUndefined();

    mkdirSync(join(skill, ...levels, "one-more"));
    await expect(findSkillFolderProblem(skill, checkout)).resolves.toBe(
      `is nested more than ${String(MAX_SKILL_FOLDER_DEPTH)} folders deep`,
    );
  });

  it("accepts the entry limit and refuses one entry more", async () => {
    const { checkout, skill } = makeCheckout();
    // `SKILL.md` is the skill's own and is not counted.
    for (let index = 0; index < MAX_SKILL_FOLDER_ENTRIES; index++) {
      writeFileSync(join(skill, `file-${String(index)}`), "x");
    }
    await expect(findSkillFolderProblem(skill, checkout)).resolves.toBeUndefined();

    writeFileSync(join(skill, "one-more"), "x");
    await expect(findSkillFolderProblem(skill, checkout)).resolves.toBe(
      `holds more than ${String(MAX_SKILL_FOLDER_ENTRIES)} files and folders`,
    );
  });
});
