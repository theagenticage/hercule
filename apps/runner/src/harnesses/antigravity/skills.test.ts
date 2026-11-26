/**
 * Tests staging the skills of an Antigravity Thread, on real temporary folders
 * laid out the way the runner lays out a session skills folder.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { cleanupHomes, createScratchHome } from "../testing";
import { stageAgySkills } from "./skills";

/** The runner context fields that say which skills a session has. */
type SkillsContext = Parameters<typeof stageAgySkills>[0];

afterEach(cleanupHomes);

/**
 * Lays out a session skills folder with library skills in `skills/<name>` and
 * each repository's skills as links in `repositories/<checkout>/skills` to
 * folders of a checkout, as the runner does.
 */
const createSession = (options: {
  readonly library?: ReadonlyArray<string>;
  readonly repositories?: ReadonlyArray<{ checkout: string; skills: ReadonlyArray<string> }>;
}): SkillsContext => {
  const root = createScratchHome("antigravity-skills");
  const sessionSkillsFolder = join(root, "session-skills", "s1");
  mkdirSync(sessionSkillsFolder, { recursive: true });
  for (const name of options.library ?? []) {
    mkdirSync(join(sessionSkillsFolder, "skills", name), { recursive: true });
    writeFileSync(join(sessionSkillsFolder, "skills", name, "SKILL.md"), `library ${name}\n`);
  }
  const repositorySkillsFolders: Array<string> = [];
  for (const { checkout, skills } of options.repositories ?? []) {
    const staged = join(sessionSkillsFolder, "repositories", checkout);
    mkdirSync(join(staged, "skills"), { recursive: true });
    for (const name of skills) {
      const real = join(root, "checkouts", checkout, ".agents", "skills", name);
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "SKILL.md"), `${checkout} ${name}\n`);
      symlinkSync(real, join(staged, "skills", name), "dir");
    }
    repositorySkillsFolders.push(staged);
  }
  return {
    sessionSkillsFolder,
    ...(options.library === undefined ? {} : { librarySkillsFolder: sessionSkillsFolder }),
    ...(repositorySkillsFolders.length === 0 ? {} : { repositorySkillsFolders }),
  };
};

const stage = (ctx: SkillsContext) => Effect.runPromise(stageAgySkills(ctx));

/** Returns the names linked in the folder `agy` reads, sorted. */
const listLinked = (ctx: SkillsContext): ReadonlyArray<string> =>
  readdirSync(join(ctx.sessionSkillsFolder!, ".agents", "skills")).sort();

const readLinkedSkill = (ctx: SkillsContext, name: string): string =>
  readFileSync(join(ctx.sessionSkillsFolder!, ".agents", "skills", name, "SKILL.md"), "utf8");

describe("stageAgySkills", () => {
  it("links the library skills and returns the session skills folder", async () => {
    const ctx = createSession({ library: ["review", "release"] });
    expect(await stage(ctx)).toEqual([ctx.sessionSkillsFolder]);
    expect(listLinked(ctx)).toEqual(["release", "review"]);
    expect(readLinkedSkill(ctx, "review")).toBe("library review\n");
  });

  it("links with relative links, so the folder can be read from any path", async () => {
    const ctx = createSession({
      library: ["review"],
      repositories: [{ checkout: "webshop", skills: ["deploy"] }],
    });
    await stage(ctx);
    const linkFolder = join(ctx.sessionSkillsFolder!, ".agents", "skills");
    expect(readlinkSync(join(linkFolder, "review"))).toBe(join("..", "..", "skills", "review"));
    expect(readlinkSync(join(linkFolder, "deploy"))).toBe(
      join("..", "..", "repositories", "webshop", "skills", "deploy"),
    );
  });

  it("links the skills of every checkout, reading through the repository links into the checkout", async () => {
    const ctx = createSession({
      repositories: [
        { checkout: "webshop", skills: ["deploy"] },
        { checkout: "api", skills: ["migrate"] },
      ],
    });
    expect(await stage(ctx)).toEqual([ctx.sessionSkillsFolder]);
    expect(listLinked(ctx)).toEqual(["deploy", "migrate"]);
    expect(readLinkedSkill(ctx, "deploy")).toBe("webshop deploy\n");
    expect(readLinkedSkill(ctx, "migrate")).toBe("api migrate\n");
  });

  it("links the first skill of a shared name: library, then repositories in order", async () => {
    const ctx = createSession({
      library: ["release"],
      repositories: [
        { checkout: "webshop", skills: ["release", "deploy"] },
        { checkout: "api", skills: ["deploy"] },
      ],
    });
    await stage(ctx);
    expect(listLinked(ctx)).toEqual(["deploy", "release"]);
    expect(readLinkedSkill(ctx, "release")).toBe("library release\n");
    expect(readLinkedSkill(ctx, "deploy")).toBe("webshop deploy\n");
  });

  it("returns nothing and writes nothing when the session has no skill", async () => {
    const noFolders = createSession({});
    const emptyFolders = createSession({
      library: [],
      repositories: [{ checkout: "x", skills: [] }],
    });
    for (const ctx of [noFolders, emptyFolders]) {
      expect(await stage(ctx)).toEqual([]);
      expect(existsSync(join(ctx.sessionSkillsFolder!, ".agents"))).toBe(false);
    }
  });

  it("returns nothing when the session has no session skills folder", async () => {
    expect(await stage({})).toEqual([]);
  });

  it("fails without a path in the message when the links cannot be written", async () => {
    const ctx = createSession({ library: ["review"] });
    mkdirSync(join(ctx.sessionSkillsFolder!, ".agents"));
    const failure = await Effect.runPromise(Effect.flip(stageAgySkills(ctx)));
    expect(failure.message).toMatch(
      /^The runner could not prepare the session's skills folder: [^/]+\. The Thread did not start\.$/,
    );
    expect(lstatSync(join(ctx.sessionSkillsFolder!, ".agents")).isDirectory()).toBe(true);
  });
});
