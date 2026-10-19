/**
 * Tests, with the file system calls recorded, that the listing walks links one
 * component at a time and never touches a place outside the checkout. Apart
 * from `repository.test.ts` because it replaces `node:fs/promises`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { listRepositorySkills } from "./repository";

/** The paths the listing asked the file system about, while `isRecording` is true. */
const fsCalls = vi.hoisted(() => ({ paths: [] as Array<string>, isRecording: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const record =
    <Args extends [path: string, ...rest: Array<never>], Result>(
      call: (...args: Args) => Promise<Result>,
    ) =>
    (...args: Args): Promise<Result> => {
      if (fsCalls.isRecording) fsCalls.paths.push(String(args[0]));
      return call(...args);
    };
  return {
    ...original,
    lstat: record(original.lstat),
    stat: record(original.stat),
    readlink: record(original.readlink),
    realpath: record(original.realpath),
    opendir: record(original.opendir),
    open: record(original.open),
  };
});

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  // Resolved, because macOS keeps temporary files under `/var`, a link to `/private/var`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hercule-repository-links-")));
  roots.push(root);
  return root;
};

/** Writes `<checkout>/<folder>/<name>/SKILL.md` with the given frontmatter lines. */
const writeSkill = (checkout: string, folder: string, name: string, frontmatter: string): void => {
  const file = join(checkout, folder, name, "SKILL.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\n---\n\n# ${name}\n`);
};

describe("listRepositorySkills follows links one component at a time", () => {
  beforeEach(() => {
    fsCalls.paths = [];
    fsCalls.isRecording = false;
  });

  const listApp = async (root: string) => {
    fsCalls.isRecording = true;
    try {
      return await Effect.runPromise(
        listRepositorySkills([{ remote: "github.com/acme/app", subdirectory: null, path: root }]),
      );
    } finally {
      fsCalls.isRecording = false;
    }
  };

  /** Makes a folder outside any checkout with `skills/private/SKILL.md` and `refs/` in it. */
  const makeOutside = (): string => {
    const outside = makeRoot();
    writeSkill(outside, "skills", "private", "description: The user's own");
    mkdirSync(join(outside, "refs"));
    return outside;
  };

  it("does not touch a place outside the checkout when a link in the checkout leads there", async () => {
    const root = makeRoot();
    const outside = makeOutside();
    writeSkill(root, ".agents/skills", "demo", "description: Demo");
    // `refs` stays inside the checkout by its text, but `hop` is an absolute link to the outside.
    symlinkSync(outside, join(root, "hop"));
    symlinkSync("../../../hop/refs", join(root, ".agents/skills/demo/refs"));

    const { skills, skipped } = await listApp(root);

    expect(skills).toEqual([]);
    expect(skipped).toEqual([
      {
        path: ".agents/skills/demo",
        reason:
          "`.agents/skills/demo`: its folder holds the link `refs`, which goes through a link with an absolute target; use a relative link",
      },
    ]);
    // The recording works: it saw the look at `hop` itself, which is inside the checkout.
    expect(fsCalls.paths).toContain(join(root, "hop"));
    expect(fsCalls.paths.filter((path) => path.startsWith(outside))).toEqual([]);
  });

  it("does not touch a place outside the checkout when the skills folder is reached through a link there", async () => {
    const root = makeRoot();
    const outside = makeOutside();
    symlinkSync(outside, join(root, "hop"));
    symlinkSync("hop", join(root, ".agents"));

    const { skills, skipped } = await listApp(root);

    expect(skills).toEqual([]);
    expect(skipped).toEqual([
      {
        path: ".agents/skills",
        reason: "`.agents/skills` goes through a link with an absolute target; use a relative link",
      },
    ]);
    expect(fsCalls.paths.filter((path) => path.startsWith(outside))).toEqual([]);
  });

  it("accepts a skills folder that a link in a linked folder leads back into the checkout", async () => {
    const root = makeRoot();
    writeSkill(root, "store", "deploy", "description: Deploys");
    mkdirSync(join(root, "metadata/agent"), { recursive: true });
    symlinkSync("metadata/agent", join(root, ".agents"));
    // Relative to `metadata/agent`, where `.agents` really is, and not to `.agents`.
    symlinkSync("../../store", join(root, "metadata/agent/skills"));

    const { skills, skipped } = await listApp(root);

    expect(skipped).toEqual([]);
    expect(skills.map(({ name, absolutePath }) => [name, absolutePath])).toEqual([
      ["deploy", join(root, "store/deploy")],
    ]);
  });

  it("refuses a link that climbs above the checkout, even when it comes back in, before touching anything", async () => {
    const root = makeRoot();
    writeSkill(root, "store", "deploy", "description: Deploys");
    mkdirSync(join(root, ".agents"));
    // On a file system that ignores letter case this is `<root>/store`. The runner cannot tell,
    // and a path above the checkout is never looked at.
    const spelling = basename(root).toUpperCase();
    symlinkSync(`../../${spelling}/store`, join(root, ".agents/skills"));

    const { skills, skipped } = await listApp(root);

    expect(skills).toEqual([]);
    expect(skipped).toEqual([
      { path: ".agents/skills", reason: "`.agents/skills` leads outside its checkout" },
    ]);
    expect(fsCalls.paths.filter((path) => !path.startsWith(root))).toEqual([]);
  });

  it("refuses a path that goes through more than 40 links", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".agents"));
    symlinkSync("skills", join(root, ".agents/skills"));

    const { skills, skipped } = await listApp(root);

    expect(skills).toEqual([]);
    expect(skipped).toEqual([
      { path: ".agents/skills", reason: "`.agents/skills` goes through more than 40 links" },
    ]);
  });
});
