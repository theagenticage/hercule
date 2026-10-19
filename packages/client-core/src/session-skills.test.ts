import { assert, describe, it } from "vitest";
import type { SessionSkill } from "@hercule/contract";
import { filterSessionSkills } from "./session-skills";

const buildLibrarySkill = (name: string, description: string): SessionSkill => ({
  source: "library",
  name,
  description,
});

const buildRepositorySkill = (name: `${string}:${string}`, description: string): SessionSkill => ({
  source: "repository",
  name,
  description,
  path: `.agents/skills/${name.slice(name.indexOf(":") + 1)}`,
});

const implement = buildLibrarySkill("implement", "Build a locked SPEC one slice at a time");
const review = buildLibrarySkill("review", "Review a diff with independent reviewers");
const ship = buildLibrarySkill("ship", "Check the outgoing set, then open pull requests");
const webshopRelease = buildRepositorySkill(
  "webshop:release",
  "Walk the checklist before a deploy",
);
const webshopReview = buildRepositorySkill("webshop:review", "Review a checkout change");
const skills = [implement, review, ship, webshopRelease, webshopReview];

const listSkillNames = (list: ReadonlyArray<SessionSkill>): ReadonlyArray<string> =>
  list.map((skill) => skill.name);

describe("filterSessionSkills", () => {
  it.each([
    { title: "an empty query returns every skill in order", query: "", expected: skills },
    { title: "a blank query is empty", query: "  ", expected: skills },
    { title: "a name prefix", query: "rev", expected: [review, webshopReview] },
    { title: "a name prefix of a repository skill", query: "rel", expected: [webshopRelease] },
    { title: "case is ignored", query: "REV", expected: [review, webshopReview] },
    {
      title: "surrounding whitespace is ignored",
      query: " rev ",
      expected: [review, webshopReview],
    },
    {
      title: "the checkout part of a repository name",
      query: "webshop",
      expected: [webshopRelease, webshopReview],
    },
    { title: "a name with its checkout", query: "webshop:rev", expected: [webshopReview] },
    { title: "the middle of a name", query: "lement", expected: [implement] },
    { title: "nothing matches", query: "zzz", expected: [] },
  ])("$title", ({ query, expected }) => {
    assert.deepStrictEqual(filterSessionSkills(skills, query), expected);
  });

  it("lists name matches before description matches, each in the order given", () => {
    // `ship` has "pull requests" and `review` has "Review a diff": only descriptions hold "re" in ship.
    const result = filterSessionSkills([implement, ship, review, webshopRelease], "re");
    assert.deepStrictEqual(listSkillNames(result), ["review", "webshop:release", "ship"]);
  });

  it("matches a description when no name matches", () => {
    assert.deepStrictEqual(filterSessionSkills(skills, "deploy"), [webshopRelease]);
  });

  it("keeps a library skill and a repository skill of the same short name, library first", () => {
    assert.deepStrictEqual(listSkillNames(filterSessionSkills(skills, "review")), [
      "review",
      "webshop:review",
    ]);
  });

  it("does not change the list it is given", () => {
    const given = [...skills];
    filterSessionSkills(given, "rev");
    assert.deepStrictEqual(given, skills);
  });
});
