/**
 * Tests the bounds of the skill folder check on a temporary directory. The
 * rules about links and second skills are tested through the listing, in
 * `repository.test.ts`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildListingBudget, MAX_LISTING_ENTRIES, resolveWithinCheckout } from "./files";
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

/** Runs the check with a fresh budget, passing the skill folder's identity as the listing does. */
const find = async (
  skill: string,
  checkout: string,
  budget = buildListingBudget(new AbortController().signal),
) => {
  const reached = await resolveWithinCheckout(
    checkout,
    dirname(skill),
    basename(skill),
    buildListingBudget(new AbortController().signal),
  );
  if (!("identity" in reached)) throw new Error("the skill folder was not reached");
  return findSkillFolderProblem(skill, checkout, budget, reached.identity);
};

describe("findSkillFolderProblem", () => {
  it("accepts a folder with files, folders and a link to a file in the checkout", async () => {
    const { checkout, skill } = makeCheckout();
    mkdirSync(join(skill, "scripts"));
    writeFileSync(join(skill, "scripts/run.sh"), "echo");
    writeFileSync(join(checkout, "shared.md"), "x");
    symlinkSync("../../../shared.md", join(skill, "shared.md"));

    await expect(find(skill, checkout)).resolves.toBeUndefined();
  });

  it("accepts folders down to the depth limit and refuses the next level", async () => {
    const { checkout, skill } = makeCheckout();
    const levels = Array.from(
      { length: MAX_SKILL_FOLDER_DEPTH },
      (_, level) => `d${String(level)}`,
    );
    mkdirSync(join(skill, ...levels), { recursive: true });
    await expect(find(skill, checkout)).resolves.toBeUndefined();

    mkdirSync(join(skill, ...levels, "one-more"));
    await expect(find(skill, checkout)).resolves.toEqual({
      refusal: `is nested more than ${String(MAX_SKILL_FOLDER_DEPTH)} folders deep`,
    });
  });

  it("accepts the entry limit and refuses one entry more", async () => {
    const { checkout, skill } = makeCheckout();
    // `SKILL.md` is read like any other entry, so it takes one place of the limit.
    for (let index = 0; index < MAX_SKILL_FOLDER_ENTRIES - 1; index++) {
      writeFileSync(join(skill, `file-${String(index)}`), "x");
    }
    await expect(find(skill, checkout)).resolves.toBeUndefined();

    writeFileSync(join(skill, "one-more"), "x");
    await expect(find(skill, checkout)).resolves.toEqual({
      refusal: `holds more than ${String(MAX_SKILL_FOLDER_ENTRIES)} files and folders`,
    });
  });

  it("refuses a link with an absolute target, even one into the checkout, without following it", async () => {
    const { checkout, skill } = makeCheckout();
    writeFileSync(join(checkout, "shared.md"), "x");
    symlinkSync(join(checkout, "shared.md"), join(skill, "inside.md"));
    expect(await find(skill, checkout)).toEqual({
      refusal:
        "holds the link `inside.md`, which goes through a link with an absolute target; use a relative link",
    });
  });

  it("refuses a link whose text leaves the checkout without touching its target", async () => {
    const { checkout, skill } = makeCheckout();
    // The target does not exist: a refusal by its text says "outside", where following it would say "cannot be followed".
    symlinkSync("../../../../never-created/deeper", join(skill, "away"));
    await expect(find(skill, checkout)).resolves.toEqual({
      refusal: "holds the link `away`, which leads outside its checkout",
    });
  });

  it("stops and reports a spent budget when the listing has no entries left", async () => {
    const { checkout, skill } = makeCheckout();
    writeFileSync(join(skill, "one"), "x");
    writeFileSync(join(skill, "two"), "x");
    const budget = buildListingBudget(new AbortController().signal);
    budget.entriesLeft = 1;
    await expect(find(skill, checkout, budget)).resolves.toEqual({
      budgetSpent: true,
    });
    expect(budget.isSpent).toBe(true);
  });

  it("draws every entry from the budget it is given", async () => {
    const { checkout, skill } = makeCheckout();
    mkdirSync(join(skill, "scripts"));
    writeFileSync(join(skill, "scripts/run.sh"), "echo");
    const budget = buildListingBudget(new AbortController().signal);
    await find(skill, checkout, budget);
    // `SKILL.md`, `scripts`, looking at `scripts` again before entering it, and `scripts/run.sh`.
    expect(MAX_LISTING_ENTRIES - budget.entriesLeft).toBe(4);
  });
});
