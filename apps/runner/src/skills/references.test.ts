/** Tests that a message's Skill References resolve against the skills a session loaded. */
import { describe, expect, it } from "vitest";
import { buildLoadedSkills, resolveSkillReferences } from "./references";

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
