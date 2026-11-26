/** Tests that a message's Skill References resolve against the skills a session loaded. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildLoadedSkills,
  resolveSkillFile,
  resolveSkillFiles,
  resolveSkillReferences,
} from "./references";

const loaded = buildLoadedSkills({
  libraryFolder: "/home/session-skills/s1-abc",
  libraryNames: ["review", "release"],
  repositorySkills: [
    {
      checkoutName: "webshop",
      name: "release",
      absolutePath: "/work/webshop/.agents/skills/release",
    },
    { checkoutName: "api", name: "deploy", absolutePath: "/work/api/.claude/skills/deploy" },
  ],
});

describe("resolveSkillReferences", () => {
  it("resolves a library skill to its folder in the library skills folder", () => {
    expect(resolveSkillReferences("please $review this", loaded)).toEqual([
      {
        source: "library",
        skillName: "review",
        folder: "/home/session-skills/s1-abc/skills/review",
        referenceName: "review",
        start: 7,
        end: 14,
      },
    ]);
  });

  it("resolves a repository skill to its real folder in the checkout", () => {
    expect(resolveSkillReferences("$api:deploy", loaded)).toEqual([
      {
        source: "repository",
        skillName: "deploy",
        checkoutName: "api",
        folder: "/work/api/.claude/skills/deploy",
        referenceName: "api:deploy",
        start: 0,
        end: 11,
      },
    ]);
  });

  it("tells a library skill from a repository skill of the same name by the reference", () => {
    const [library, repository] = resolveSkillReferences("$release then $webshop:release", loaded);
    expect(library).toMatchObject({
      source: "library",
      folder: "/home/session-skills/s1-abc/skills/release",
    });
    expect(repository).toMatchObject({
      source: "repository",
      checkoutName: "webshop",
      folder: "/work/webshop/.agents/skills/release",
    });
  });

  it("leaves out a token that names no loaded skill", () => {
    expect(resolveSkillReferences("$reveiw $api:missing $other:deploy $deploy", loaded)).toEqual(
      [],
    );
  });

  it("leaves out a repository skill that was not staged for the process", () => {
    const withoutApi = buildLoadedSkills({
      libraryFolder: undefined,
      libraryNames: [],
      repositorySkills: [],
    });
    expect(resolveSkillReferences("$api:deploy", withoutApi)).toEqual([]);
  });

  it("resolves no library skill when the start has no library skills folder", () => {
    const none = buildLoadedSkills({
      libraryFolder: undefined,
      libraryNames: ["review"],
      repositorySkills: [],
    });
    expect(resolveSkillReferences("$review", none)).toEqual([]);
  });

  it("leaves out a token inside code", () => {
    expect(resolveSkillReferences("`$review` and\n```\n$api:deploy\n```\n", loaded)).toEqual([]);
  });

  it("keeps every occurrence of a repeated reference, in text order, with its own offsets", () => {
    const resolved = resolveSkillReferences("$review a $api:deploy b $review", loaded);
    expect(resolved.map(({ referenceName, start, end }) => [referenceName, start, end])).toEqual([
      ["review", 0, 7],
      ["api:deploy", 10, 21],
      ["review", 24, 31],
    ]);
  });

  it("returns nothing for a text without references", () => {
    expect(resolveSkillReferences("costs $5", loaded)).toEqual([]);
  });
});

describe("resolveSkillFile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hercule-skill-file-")));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns the path of the SKILL.md of a normal skill folder", () => {
    const folder = join(root, "normal");
    mkdirSync(folder);
    writeFileSync(join(folder, "SKILL.md"), "# normal\n");
    expect(resolveSkillFile(folder)).toBe(join(folder, "SKILL.md"));
  });

  it("returns the path in the real folder for a skill folder that is a link", () => {
    const folder = join(root, "real");
    mkdirSync(folder);
    writeFileSync(join(folder, "SKILL.md"), "# real\n");
    symlinkSync(folder, join(root, "linked"), "dir");
    expect(resolveSkillFile(join(root, "linked"))).toBe(join(folder, "SKILL.md"));
  });

  it("returns undefined when the folder has no SKILL.md", () => {
    const folder = join(root, "empty");
    mkdirSync(folder);
    expect(resolveSkillFile(folder)).toBeUndefined();
    expect(resolveSkillFile(join(root, "missing"))).toBeUndefined();
  });

  it("returns undefined when SKILL.md is a folder", () => {
    const folder = join(root, "folder-skill");
    mkdirSync(join(folder, "SKILL.md"), { recursive: true });
    expect(resolveSkillFile(folder)).toBeUndefined();
  });

  it("returns undefined when SKILL.md is a link to a file outside the folder", () => {
    const folder = join(root, "escaping");
    mkdirSync(folder);
    writeFileSync(join(root, "secret.md"), "secret\n");
    symlinkSync(join(root, "secret.md"), join(folder, "SKILL.md"));
    expect(resolveSkillFile(folder)).toBeUndefined();
  });
});

describe("resolveSkillFiles", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hercule-skill-files-")));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Creates the skills `names` in the library, `missing` ones without a SKILL.md, and returns the references in `text`. */
  const referenceSkills = (
    text: string,
    names: ReadonlyArray<string>,
    missing: ReadonlyArray<string> = [],
  ) => {
    const libraryFolder = mkdtempSync(join(root, "library-"));
    for (const name of names) {
      mkdirSync(join(libraryFolder, "skills", name), { recursive: true });
      if (!missing.includes(name)) {
        writeFileSync(join(libraryFolder, "skills", name, "SKILL.md"), `# ${name}\n`);
      }
    }
    const references = resolveSkillReferences(
      text,
      buildLoadedSkills({ libraryFolder, libraryNames: names, repositorySkills: [] }),
    );
    return { libraryFolder, references };
  };

  it("returns one entry per skill folder, in order of first reference, with the first reference", () => {
    const { libraryFolder, references } = referenceSkills(
      "$release then $review then $release again",
      ["review", "release"],
    );

    const { found, skipped } = resolveSkillFiles(references);

    expect(found).toEqual([
      {
        reference: references[0],
        skillFile: join(libraryFolder, "skills", "release", "SKILL.md"),
      },
      {
        reference: references[1],
        skillFile: join(libraryFolder, "skills", "review", "SKILL.md"),
      },
    ]);
    expect(skipped).toEqual([]);
  });

  it("skips a skill whose file is rejected, once, however often it is named", () => {
    const { references } = referenceSkills("$gone, $review, $gone", ["review", "gone"], ["gone"]);

    const { found, skipped } = resolveSkillFiles(references);

    expect(found.map(({ reference }) => reference.referenceName)).toEqual(["review"]);
    expect(skipped).toEqual(["gone"]);
  });

  it("returns nothing for no references", () => {
    expect(resolveSkillFiles([])).toEqual({ found: [], skipped: [] });
  });
});
