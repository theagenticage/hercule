import { beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { PickedSkillFolders, PickedSkillFoldersLayer } from "./picked-skill-folders";
import { type FakeMainWindow, makeFakeMainWindow } from "./testing";

let folder: string;
let window: FakeMainWindow;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hercule-desktop-skill-folders-"));
  window = makeFakeMainWindow();
  return () => rmSync(folder, { recursive: true, force: true });
});

/** Creates the skill folder `name` in `parent`, holding a `SKILL.md`, and returns its path. */
const createSkillFolder = (parent: string, name: string): string => {
  const skillFolder = join(parent, name);
  mkdirSync(skillFolder, { recursive: true });
  writeFileSync(join(skillFolder, "SKILL.md"), `---\nname: ${name}\ndescription: A skill.\n---\n`);
  return skillFolder;
};

/** Runs `effect` with a PickedSkillFolders service of its own, on the fake window. */
const runWithPickedSkillFolders = <A, E>(effect: Effect.Effect<A, E, PickedSkillFolders>) =>
  Effect.runPromise(
    Effect.provide(effect, PickedSkillFoldersLayer.pipe(Layer.provide(window.layer))),
  );

/** Returns the path of the first entry of a tar archive, from its header's name field. */
const readFirstArchivePath = (archive: Uint8Array): string =>
  new TextDecoder().decode(archive.subarray(0, 100)).replace(/\0+$/, "");

describe("PickedSkillFolders", () => {
  it("finds the skills in the picked folder and builds the archive of one by its name", async () => {
    const skills = join(folder, "skills");
    createSkillFolder(skills, "teach");
    createSkillFolder(skills, "grilling");
    writeFileSync(
      join(folder, ".skill-lock.json"),
      JSON.stringify({
        skills: {
          grilling: {
            source: "mattpocock/skills",
            sourceType: "github",
            skillPath: "skills/grilling/SKILL.md",
          },
        },
      }),
    );
    window.pickedFolder = skills;

    const { picked, built } = await runWithPickedSkillFolders(
      Effect.gen(function* () {
        const folders = yield* PickedSkillFolders;
        return { picked: yield* folders.pick, built: yield* folders.buildArchive("teach") };
      }),
    );

    expect(picked).toEqual({
      _tag: "Picked",
      displayPath: skills,
      lockFileProblem: null,
      skills: [
        { name: "grilling", source: { repo: "mattpocock/skills", path: "skills/grilling" } },
        { name: "teach", source: null },
      ],
    });
    if (built._tag !== "Archive") throw new Error(`Expected an archive, got ${built._tag}`);
    expect(readFirstArchivePath(built.archive)).toBe("SKILL.md");
    expect(new TextDecoder().decode(built.archive.subarray(257, 262))).toBe("ustar");
  });

  it("refuses a name that was not in the last Picked answer, and any name before one", async () => {
    window.pickedFolder = null;
    const refusals = await runWithPickedSkillFolders(
      Effect.gen(function* () {
        const folders = yield* PickedSkillFolders;
        const cancelled = yield* folders.pick;
        const beforeAnyPick = yield* Effect.flip(folders.buildArchive("teach"));
        window.pickedFolder = createSkillFolder(folder, "teach");
        yield* folders.pick;
        // The renderer cannot reach a folder beside the picked one by its name.
        createSkillFolder(folder, "grilling");
        const unknown = yield* Effect.flip(folders.buildArchive("grilling"));
        const path = yield* Effect.flip(folders.buildArchive(join(folder, "grilling")));
        return { cancelled, beforeAnyPick, unknown, path };
      }),
    );

    expect(refusals.cancelled).toEqual({ _tag: "Cancelled" });
    expect(refusals.beforeAnyPick).toMatchObject({
      _tag: "SkillNotPicked",
      message: "no folder of skills has been picked",
    });
    expect(refusals.unknown).toMatchObject({
      _tag: "SkillNotPicked",
      message: '"grilling" is not a skill of the folder picked last',
    });
    expect(refusals.path._tag).toBe("SkillNotPicked");
  });

  it("keeps the last Picked answer when a later pick is cancelled or unreadable", async () => {
    window.pickedFolder = createSkillFolder(folder, "teach");
    const outcomes = await runWithPickedSkillFolders(
      Effect.gen(function* () {
        const folders = yield* PickedSkillFolders;
        yield* folders.pick;
        window.pickedFolder = null;
        const cancelled = yield* folders.pick;
        window.pickedFolder = join(folder, "gone");
        const unreadable = yield* folders.pick;
        const built = yield* folders.buildArchive("teach");
        return { cancelled, unreadable, built: built._tag };
      }),
    );

    expect(outcomes.cancelled).toEqual({ _tag: "Cancelled" });
    expect(outcomes.unreadable).toEqual({
      _tag: "Unreadable",
      reason: `\`${join(folder, "gone")}\` cannot be read: it does not exist.`,
    });
    expect(outcomes.built).toBe("Archive");
  });

  it("answers Unreadable, naming the link, for a link that points outside the skill's folder", async () => {
    const teach = createSkillFolder(folder, "teach");
    writeFileSync(join(folder, "secret.txt"), "not part of the skill");
    symlinkSync(join(folder, "secret.txt"), join(teach, "notes.txt"));
    window.pickedFolder = teach;

    const built = await runWithPickedSkillFolders(
      Effect.gen(function* () {
        const folders = yield* PickedSkillFolders;
        yield* folders.pick;
        return yield* folders.buildArchive("teach");
      }),
    );

    expect(built).toEqual({
      _tag: "Unreadable",
      reason:
        "`teach/notes.txt` points outside the skill's folder. A skill holds only its own files; copy what it needs into its folder.",
    });
  });

  it("answers TooLarge for a skill whose archive would be over 10 MiB", async () => {
    const teach = createSkillFolder(folder, "teach");
    // A sparse file: the reader refuses it from its size, without reading it.
    writeFileSync(join(teach, "big.bin"), "");
    truncateSync(join(teach, "big.bin"), 11 * 1024 * 1024);
    window.pickedFolder = teach;

    const built = await runWithPickedSkillFolders(
      Effect.gen(function* () {
        const folders = yield* PickedSkillFolders;
        yield* folders.pick;
        return yield* folders.buildArchive("teach");
      }),
    );

    expect(built).toEqual({ _tag: "TooLarge" });
  });

  it("refuses a second archive while one is being built, and builds the next once it is done", async () => {
    const skills = join(folder, "skills");
    createSkillFolder(skills, "teach");
    createSkillFolder(skills, "grilling");
    window.pickedFolder = skills;

    const outcomes = await runWithPickedSkillFolders(
      Effect.gen(function* () {
        const folders = yield* PickedSkillFolders;
        yield* folders.pick;
        const [first, second] = yield* Effect.all(
          [folders.buildArchive("teach"), Effect.flip(folders.buildArchive("grilling"))],
          { concurrency: "unbounded" },
        );
        const after = yield* folders.buildArchive("grilling");
        return { first: first._tag, second, after: after._tag };
      }),
    );

    expect(outcomes.first).toBe("Archive");
    expect(outcomes.second._tag).toBe("SkillArchiveBuildRunning");
    expect(outcomes.after).toBe("Archive");
  });
});
