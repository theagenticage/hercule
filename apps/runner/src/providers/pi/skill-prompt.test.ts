/**
 * Tests the prompt text pi gets for an input with Skill References, on real
 * staged skill folders, and through the adapter for both ways an input
 * reaches pi.
 */
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { buildLoadedSkills, resolveSkillReferences } from "../../skills/references";
import type { AdapterTurnInput } from "../index";
import { buildHarnessPrompt } from "../prompt";
import { writeTestImage } from "../testing";
import { buildPiPrompt } from "./skill-prompt";
import {
  cleanupHomes,
  createPiHome,
  listSentCommands,
  SESSION,
  SPEC,
  startBusySession,
  startTestSession,
} from "./testing";

afterAll(cleanupHomes);

const SENDER = "0199e0e7-0000-7000-8000-0000000000e1";
const HEADER = `[Message from session ${SENDER}, another agent. To reply: hercule session input ${SENDER}]`;

/**
 * The skills of a staged session the way the runner lays them out: library
 * skills as folders in `<library>/skills`, and each repository skill as a link
 * in `<library>/repositories/<checkout>/skills` to a folder in its checkout.
 * `repositories` lists the checkouts in workspace order.
 */
const stageSkills = (options: {
  readonly library: ReadonlyArray<string>;
  readonly repositories: ReadonlyArray<{ checkout: string; skills: ReadonlyArray<string> }>;
}) => {
  const root = createPiHome();
  const libraryFolder = join(root, "session-skills");
  for (const name of options.library)
    mkdirSync(join(libraryFolder, "skills", name), { recursive: true });
  const repositorySkillsFolders: Array<string> = [];
  const repositorySkills: Array<{ checkoutName: string; name: string; absolutePath: string }> = [];
  for (const { checkout, skills } of options.repositories) {
    const staged = join(libraryFolder, "repositories", checkout);
    mkdirSync(join(staged, "skills"), { recursive: true });
    for (const name of skills) {
      const absolutePath = join(root, "checkouts", checkout, ".agents", "skills", name);
      mkdirSync(absolutePath, { recursive: true });
      symlinkSync(absolutePath, join(staged, "skills", name), "dir");
      repositorySkills.push({ checkoutName: checkout, name, absolutePath });
    }
    repositorySkillsFolders.push(staged);
  }
  const loaded = buildLoadedSkills({
    libraryFolder,
    libraryNames: options.library,
    repositorySkills,
  });
  return {
    libraryFolder,
    repositorySkillsFolders,
    /** Builds an input whose references are the ones `text` names. */
    buildInput: (text: string, rest: Partial<AdapterTurnInput> = {}): AdapterTurnInput => ({
      text,
      skillReferences: resolveSkillReferences(text, loaded),
      ...rest,
    }),
    buildPrompt: (input: AdapterTurnInput) =>
      buildPiPrompt(input, [libraryFolder, ...repositorySkillsFolders]),
    pathOf: (referenceName: string) => loaded.get(referenceName)!.folder,
  };
};

describe("building the prompt for pi", () => {
  it("is the harness prompt, unchanged, when there are no references", () => {
    const staged = stageSkills({ library: ["review"], repositories: [] });
    const image = writeTestImage();
    for (const input of [
      staged.buildInput("plain text"),
      staged.buildInput("not a skill: $unknown", { senderSessionId: SENDER, attachments: [image] }),
    ]) {
      expect(staged.buildPrompt(input)).toBe(buildHarnessPrompt(input));
    }
  });

  it("runs a library skill as the leading command and removes its token", () => {
    const staged = stageSkills({ library: ["review"], repositories: [] });

    expect(staged.buildPrompt(staged.buildInput("please $review the diff"))).toBe(
      "/skill:review please the diff",
    );
    expect(staged.buildPrompt(staged.buildInput("$review the diff"))).toBe(
      "/skill:review the diff",
    );
    expect(staged.buildPrompt(staged.buildInput("the diff, with $review"))).toBe(
      "/skill:review the diff, with",
    );
    expect(staged.buildPrompt(staged.buildInput("first line\n$review go"))).toBe(
      "/skill:review first line\ngo",
    );
    expect(staged.buildPrompt(staged.buildInput("$review"))).toBe("/skill:review");
  });

  it("runs a repository skill under its bare name", () => {
    const staged = stageSkills({
      library: [],
      repositories: [{ checkout: "webshop", skills: ["release"] }],
    });

    expect(staged.buildPrompt(staged.buildInput("$webshop:release now"))).toBe(
      "/skill:release now",
    );
  });

  it("runs the first skill and points the model at the second", () => {
    const staged = stageSkills({ library: ["review", "deploy"], repositories: [] });

    expect(staged.buildPrompt(staged.buildInput("$review then $deploy it"))).toBe(
      `/skill:review then $deploy it\n\n[Skill "$deploy" is at ${join(staged.pathOf("deploy"), "SKILL.md")}. Read it with the read tool and follow it.]`,
    );
  });

  it("puts the command first, then the header, the text, the image lines and the pointers", () => {
    const staged = stageSkills({ library: ["review", "deploy"], repositories: [] });
    const image = writeTestImage({ name: "shot.png" });

    expect(
      staged.buildPrompt(
        staged.buildInput("$review and $deploy this", {
          senderSessionId: SENDER,
          attachments: [image],
        }),
      ),
    ).toBe(
      [
        `/skill:review ${HEADER}`,
        "and $deploy this",
        `[Attached image "shot.png" is saved at: ${image.path}]`,
        `[Skill "$deploy" is at ${join(staged.pathOf("deploy"), "SKILL.md")}. Read it with the read tool and follow it.]`,
      ].join("\n\n"),
    );
  });

  it("translates a skill named twice once, and leaves the second token in the text", () => {
    const staged = stageSkills({ library: ["review"], repositories: [] });

    expect(staged.buildPrompt(staged.buildInput("$review this and $review that"))).toBe(
      "/skill:review this and $review that",
    );
  });

  it("points at a skill that pi does not run once, however often it is named", () => {
    const staged = stageSkills({
      library: ["release"],
      repositories: [{ checkout: "webshop", skills: ["release"] }],
    });

    const prompt = staged.buildPrompt(
      staged.buildInput("$webshop:release, I said $webshop:release"),
    );

    expect(prompt.match(/\[Skill /g)).toHaveLength(1);
  });

  it("points at the library skill that lost its name and leads with the next skill", () => {
    const staged = stageSkills({
      library: [],
      repositories: [
        { checkout: "api", skills: ["release"] },
        { checkout: "web", skills: ["release", "lint"] },
      ],
    });

    // `api` comes before `web`, so pi keeps api's `release` and drops web's.
    expect(staged.buildPrompt(staged.buildInput("$web:release then $web:lint"))).toBe(
      `/skill:lint $web:release then\n\n[Skill "$web:release" is at ${join(staged.pathOf("web:release"), "SKILL.md")}. Read it with the read tool and follow it.]`,
    );
    expect(staged.buildPrompt(staged.buildInput("$api:release"))).toBe("/skill:release");
  });

  it("lets a library skill win a bare name over a repository skill, even when the repository skill is not named", () => {
    const staged = stageSkills({
      library: ["release"],
      repositories: [{ checkout: "webshop", skills: ["release"] }],
    });

    expect(staged.buildPrompt(staged.buildInput("$webshop:release"))).toBe(
      `$webshop:release\n\n[Skill "$webshop:release" is at ${join(staged.pathOf("webshop:release"), "SKILL.md")}. Read it with the read tool and follow it.]`,
    );
    expect(staged.buildPrompt(staged.buildInput("$webshop:release and $release"))).toBe(
      `/skill:release $webshop:release and\n\n[Skill "$webshop:release" is at ${join(staged.pathOf("webshop:release"), "SKILL.md")}. Read it with the read tool and follow it.]`,
    );
  });
});

describe("sending an input with Skill References to pi", () => {
  for (const [command, start] of [
    ["prompt", startTestSession],
    ["steer", startBusySession],
  ] as const) {
    it(`sends the command first on a ${command}`, async () => {
      const staged = stageSkills({ library: ["review"], repositories: [] });
      const run = await start({}, SPEC, {}, { librarySkillsFolder: staged.libraryFolder });

      await Effect.runPromise(
        run.adapter.sendInput(SESSION, staged.buildInput("$review the diff")),
      );

      expect(listSentCommands(run.sent, command).at(-1)).toMatchObject({
        message: "/skill:review the diff",
      });
    });
  }
});
