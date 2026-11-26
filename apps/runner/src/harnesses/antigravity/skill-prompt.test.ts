/**
 * Tests the prompt text `agy` gets for an input with Skill References, on real
 * skill folders.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildLoadedSkills, resolveSkillReferences } from "../../skills";
import type { AdapterTurnInput } from "../index";
import { buildHarnessPrompt } from "../prompt";
import { cleanupHomes, createScratchHome, writeTestImage } from "../testing";
import { buildAgyPrompt } from "./skill-prompt";

afterEach(cleanupHomes);

const SENDER = "0199e0e7-0000-7000-8000-0000000000e1";

/** Creates a skill folder, with a `SKILL.md` unless `withFile` is false. */
const createSkillFolder = (folder: string, withFile = true): string => {
  mkdirSync(folder, { recursive: true });
  if (withFile) writeFileSync(join(folder, "SKILL.md"), "# skill\n");
  return folder;
};

/** Returns a builder of inputs whose references name the given skills. */
const createSkills = (options: {
  readonly library: ReadonlyArray<string>;
  readonly repository?: ReadonlyArray<string>;
  readonly missingFile?: ReadonlyArray<string>;
  readonly root?: string;
}) => {
  const root = options.root ?? createScratchHome("antigravity-skill-prompt");
  const libraryFolder = join(root, "session-skills");
  for (const name of options.library) {
    createSkillFolder(join(libraryFolder, "skills", name), !options.missingFile?.includes(name));
  }
  const repositorySkills = (options.repository ?? []).map((name) => ({
    checkoutName: "webshop",
    name,
    absolutePath: createSkillFolder(join(root, "checkout", ".agents", "skills", name)),
  }));
  const loaded = buildLoadedSkills({
    libraryFolder,
    libraryNames: options.library,
    repositorySkills,
  });
  return {
    libraryFolder,
    repositorySkills,
    buildInput: (text: string, rest: Partial<AdapterTurnInput> = {}): AdapterTurnInput => ({
      text,
      skillReferences: resolveSkillReferences(text, loaded),
      ...rest,
    }),
  };
};

describe("buildAgyPrompt", () => {
  it("returns the harness prompt, unchanged, when there are no references", () => {
    const skills = createSkills({ library: ["review"] });
    const image = writeTestImage();
    for (const input of [
      skills.buildInput("plain text"),
      skills.buildInput("not a skill: $unknown", { senderSessionId: SENDER, attachments: [image] }),
    ]) {
      expect(buildAgyPrompt(input)).toEqual({
        text: buildHarnessPrompt(input),
        skillReferences: [],
        skipped: [],
      });
    }
  });

  it("adds one pointer line with the exact path after the prompt and keeps the token", () => {
    const skills = createSkills({ library: ["review"] });
    const input = skills.buildInput("please $review this");
    const { text, skillReferences } = buildAgyPrompt(input);
    const path = join(skills.libraryFolder, "skills", "review", "SKILL.md");
    expect(text).toBe(
      `please $review this\n\n[Skill "$review": read and use the skill at ${JSON.stringify(path)}.]`,
    );
    expect(skillReferences).toEqual(input.skillReferences);
  });

  it("names a repository skill by its reference and points at the file in the checkout", () => {
    const skills = createSkills({ library: [], repository: ["deploy"] });
    const input = skills.buildInput("$webshop:deploy");
    const path = join(skills.repositorySkills[0]!.absolutePath, "SKILL.md");
    expect(buildAgyPrompt(input).text).toBe(
      `$webshop:deploy\n\n[Skill "$webshop:deploy": read and use the skill at ${JSON.stringify(path)}.]`,
    );
  });

  it("puts the pointer lines after the sender header and the image lines", () => {
    const skills = createSkills({ library: ["review"] });
    const input = skills.buildInput("$review", {
      senderSessionId: SENDER,
      attachments: [writeTestImage()],
    });
    const { text } = buildAgyPrompt(input);
    const prompt = buildHarnessPrompt(input);
    expect(prompt).toContain(SENDER);
    expect(prompt).toContain("[Attached image");
    expect(text.startsWith(`${prompt}\n\n[Skill "$review"`)).toBe(true);
  });

  it("returns the lines alone when the prompt is empty", () => {
    const skills = createSkills({ library: ["review"] });
    const input = skills.buildInput("$review");
    const path = join(skills.libraryFolder, "skills", "review", "SKILL.md");
    expect(buildAgyPrompt({ ...input, text: "" }).text).toBe(
      `[Skill "$review": read and use the skill at ${JSON.stringify(path)}.]`,
    );
  });

  it("writes a path with a quote, a space and a line break as one JSON string", () => {
    const root = createScratchHome("antigravity-skill-prompt");
    const skills = createSkills({ library: ["review"], root: join(root, 'odd "dir"\nname') });
    const { text } = buildAgyPrompt(skills.buildInput("$review"));
    const line = text.split("\n\n")[1]!;
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain(
      JSON.stringify(join(skills.libraryFolder, "skills", "review", "SKILL.md")),
    );
  });

  it("leaves out a skill whose SKILL.md is missing, and its references", () => {
    const skills = createSkills({ library: ["review", "gone"], missingFile: ["gone"] });
    const input = skills.buildInput("$gone and $review");
    const { text, skillReferences, skipped } = buildAgyPrompt(input);
    expect(text).not.toContain('"$gone"');
    expect(text).toContain('"$review"');
    expect(skillReferences.map((reference) => reference.referenceName)).toEqual(["review"]);
    expect(skipped).toEqual(["gone"]);
  });

  it("returns the prompt alone when no referenced skill has a file", () => {
    const skills = createSkills({ library: ["gone"], missingFile: ["gone"] });
    const input = skills.buildInput("run $gone");
    expect(buildAgyPrompt(input)).toEqual({
      text: "run $gone",
      skillReferences: [],
      skipped: ["gone"],
    });
  });

  it("keeps the text first and unchanged, so a slash command the user typed stays one", () => {
    const skills = createSkills({ library: ["review"] });
    const input = skills.buildInput("/compact $review");
    const { text, skillReferences } = buildAgyPrompt(input);
    expect(text.startsWith('/compact $review\n\n[Skill "$review"')).toBe(true);
    expect(skillReferences).toEqual(input.skillReferences);
  });

  it("gives a skill reference in a text that starts with a path its pointer line", () => {
    const skills = createSkills({ library: ["review"] });
    const input = skills.buildInput("/tmp/build.log fails, $review it");
    const { text, skillReferences, skipped } = buildAgyPrompt(input);
    expect(text.startsWith('/tmp/build.log fails, $review it\n\n[Skill "$review"')).toBe(true);
    expect(skillReferences.map((reference) => reference.referenceName)).toEqual(["review"]);
    expect(skipped).toEqual([]);
  });
});
