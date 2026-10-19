/** Tests which skill names are read from `.claude/skills` folders, and the limit on how many. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { MAX_LISTING_ENTRIES } from "./files";
import { listNativeClaudeSkills } from "./native";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  // Resolved, because macOS keeps temporary files under `/var`, a link to `/private/var`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hercule-native-skills-")));
  roots.push(root);
  return root;
};

/** Makes `<directory>/.claude/skills` and returns its path. */
const makeSkillsFolder = (directory: string): string => {
  const folder = join(directory, ".claude", "skills");
  mkdirSync(folder, { recursive: true });
  return folder;
};

describe("listNativeClaudeSkills", () => {
  it("returns the sorted, distinct names of the folders and links, and ignores plain files", async () => {
    const root = makeRoot();
    const first = makeSkillsFolder(join(root, "first"));
    const second = makeSkillsFolder(join(root, "second"));
    mkdirSync(join(first, "release"));
    mkdirSync(join(first, "My_Skill"));
    mkdirSync(join(second, "release"));
    mkdirSync(join(second, "audit"));
    symlinkSync("release", join(first, "linked"));
    writeFileSync(join(first, ".DS_Store"), "");

    const names = await Effect.runPromise(
      listNativeClaudeSkills([join(root, "first"), join(root, "second"), join(root, "first")]),
    );

    expect(names).toEqual(["My_Skill", "audit", "linked", "release"]);
  });

  it("follows a .claude/skills that links to a folder outside the directory, because Claude does", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "elsewhere", "private-skill"), { recursive: true });
    mkdirSync(join(root, "web", ".claude"), { recursive: true });
    symlinkSync("../../elsewhere", join(root, "web", ".claude", "skills"));

    const names = await Effect.runPromise(listNativeClaudeSkills([join(root, "web")]));

    expect(names).toEqual(["private-skill"]);
  });

  it("returns no names for a directory without a .claude/skills folder", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "plain"));
    makeSkillsFolder(join(root, "empty"));

    const names = await Effect.runPromise(
      listNativeClaudeSkills([join(root, "plain"), join(root, "missing"), join(root, "empty")]),
    );

    expect(names).toEqual([]);
  });

  it("fails, naming no path, when the folders hold more entries than the listing limit", async () => {
    const root = makeRoot();
    // Plain files count too, and are cheaper to make than folders. The limit
    // is shared: two folders of half the limit each, plus one entry, go over it.
    const half = MAX_LISTING_ENTRIES / 2;
    const first = makeSkillsFolder(join(root, "first"));
    const second = makeSkillsFolder(join(root, "second"));
    for (let at = 0; at < half; at += 1) writeFileSync(join(first, `file-${String(at)}`), "");
    for (let at = 0; at <= half; at += 1) writeFileSync(join(second, `file-${String(at)}`), "");

    const reason = await Effect.runPromise(
      Effect.flip(listNativeClaudeSkills([join(root, "first"), join(root, "second")])),
    );

    expect(reason).toBe(
      "the workspace's `.claude/skills` folders hold more than 10000 entries in all, plain files included. Keep them to 10000 entries or fewer",
    );
    expect(reason).not.toContain(root);
  });
});
