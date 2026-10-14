/**
 * Tests the mapping from the paths an adapter wrote to `editedFiles`
 * (spec 19 section 4.1), on a real temporary directory, because resolving
 * symbolic links and deleted files is part of what is under test.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildSessionCheckouts,
  convertEditedFiles,
  readDetailPaths,
  type SessionCheckout,
} from "./edited-files";

const roots: Array<string> = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Makes a directory whose own path has no symbolic link in it, because macOS puts `/tmp` behind one. */
const createRoot = (): string => {
  const made = realpathSync(mkdtempSync(join(tmpdir(), "hercule-edited-")));
  roots.push(made);
  return made;
};

/** Returns only the files of a conversion. */
const listFiles = (...args: Parameters<typeof convertEditedFiles>) =>
  convertEditedFiles(...args).files;

/** Returns true when the temporary directory's filesystem treats `A` and `a` as one name. */
const isCaseInsensitive = (root: string): boolean => {
  writeFileSync(join(root, "Probe"), "");
  return existsSync(join(root, "probe"));
};

const REPO = "repo-resource";
const INNER = "inner-resource";

/** Builds the checkout `repo` under `root`, which holds `src/a.ts`. */
const buildRepo = (
  root: string,
): { readonly cwd: string; readonly checkouts: ReadonlyArray<SessionCheckout> } => {
  const cwd = join(root, "repo");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "");
  return { cwd, checkouts: buildSessionCheckouts([{ resourceId: REPO, path: cwd }]) };
};

describe("convertEditedFiles", () => {
  it("resolves a relative path against the working directory", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(listFiles(cwd, checkouts, ["src/a.ts"])).toEqual([
      { resourceId: REPO, path: "src/a.ts" },
    ]);
  });

  it("takes an absolute path as it is, and removes `.` and `..` parts", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(listFiles(cwd, checkouts, [join(cwd, "src", ".", "x", "..", "a.ts")])).toEqual([
      { resourceId: REPO, path: "src/a.ts" },
    ]);
  });

  it("finds a file through the real path of a checkout reached by a symbolic link", () => {
    const root = createRoot();
    const { cwd } = buildRepo(root);
    const link = join(root, "link");
    symlinkSync(cwd, link);
    // The checkout is registered under the link; the harness wrote the real path.
    const checkouts = buildSessionCheckouts([{ resourceId: REPO, path: link }]);
    expect(listFiles(link, checkouts, [join(cwd, "src", "a.ts")])).toEqual([
      { resourceId: REPO, path: "src/a.ts" },
    ]);
    expect(listFiles(link, checkouts, ["src/a.ts"])).toEqual([
      { resourceId: REPO, path: "src/a.ts" },
    ]);
  });

  it("finds a file reached by a link that points into the checkout", () => {
    const root = createRoot();
    const { cwd, checkouts } = buildRepo(root);
    const link = join(root, "elsewhere");
    symlinkSync(cwd, link);
    expect(listFiles(cwd, checkouts, [join(link, "src", "a.ts")])).toEqual([
      { resourceId: REPO, path: "src/a.ts" },
    ]);
  });

  it("lets the longest checkout win when checkouts nest", () => {
    const root = createRoot();
    const { cwd } = buildRepo(root);
    const inner = join(cwd, "src");
    const checkouts = buildSessionCheckouts([
      { resourceId: REPO, path: cwd },
      { resourceId: INNER, path: inner },
    ]);
    expect(listFiles(cwd, checkouts, ["src/a.ts", "other.ts"])).toEqual([
      { resourceId: INNER, path: "a.ts" },
      { resourceId: REPO, path: "other.ts" },
    ]);
  });

  it("finds a deleted file by the real path of its directory", () => {
    const root = createRoot();
    const { cwd } = buildRepo(root);
    const link = join(root, "link");
    symlinkSync(cwd, link);
    const checkouts = buildSessionCheckouts([{ resourceId: REPO, path: cwd }]);
    expect(listFiles(link, checkouts, ["src/gone.ts"])).toEqual([
      { resourceId: REPO, path: "src/gone.ts" },
    ]);
  });

  it("drops a path outside every checkout", () => {
    const root = createRoot();
    const { cwd, checkouts } = buildRepo(root);
    expect(listFiles(cwd, checkouts, [join(root, "other", "a.ts"), "/etc/hosts"])).toEqual([]);
  });

  it("drops a path that escapes the checkout with `..`", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(listFiles(cwd, checkouts, ["../outside.ts", "src/../../outside.ts"])).toEqual([]);
  });

  it("drops a sibling directory that only shares the checkout's name as a prefix", () => {
    const root = createRoot();
    const { cwd, checkouts } = buildRepo(root);
    expect(listFiles(cwd, checkouts, [`${cwd}-other/a.ts`])).toEqual([]);
  });

  it("drops the checkout's root itself", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(listFiles(cwd, checkouts, [".", cwd])).toEqual([]);
  });

  it("drops a path with a control character", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(listFiles(cwd, checkouts, ["src/a\nb.ts", "src/a\u0000.ts"])).toEqual([]);
  });

  it("drops a path longer than 1024 characters inside the checkout, and keeps one of exactly 1024", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    const exact = "a".repeat(1024);
    expect(listFiles(cwd, checkouts, [exact, "a".repeat(1025)])).toEqual([
      { resourceId: REPO, path: exact },
    ]);
  });

  it("reports each file once, in the order first seen", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(
      listFiles(cwd, checkouts, ["b.ts", "src/a.ts", join(cwd, "b.ts"), "./src/a.ts"]),
    ).toEqual([
      { resourceId: REPO, path: "b.ts" },
      { resourceId: REPO, path: "src/a.ts" },
    ]);
  });

  it("reports nothing for a session with no checkouts", () => {
    expect(listFiles("/scratch", [], ["a.ts"])).toEqual([]);
  });

  it("drops a path with a bidirectional override, a C1 control or a line separator", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(listFiles(cwd, checkouts, ["a\u202eb.ts", "a\u0085b.ts", "a\u2028b.ts"])).toEqual([]);
  });

  it("maps case variants of one file to one key on a case-insensitive filesystem", (context) => {
    const root = createRoot();
    if (!isCaseInsensitive(root)) context.skip();
    const { cwd, checkouts } = buildRepo(root);
    writeFileSync(join(cwd, "README.md"), "");
    expect(listFiles(cwd, checkouts, ["README.md", "readme.md", join(cwd, "ReadMe.MD")])).toEqual([
      { resourceId: REPO, path: "README.md" },
    ]);
  });

  it("gives one file one key when an outer checkout is registered through a link and an inner one by its real path", () => {
    const root = createRoot();
    const { cwd } = buildRepo(root);
    writeFileSync(join(cwd, "src", "index.ts"), "");
    const longLink = join(root, "a-long-link-name-that-is-longer-than-the-real-path");
    symlinkSync(cwd, longLink);
    const checkouts = buildSessionCheckouts([
      { resourceId: REPO, path: longLink },
      { resourceId: INNER, path: join(cwd, "src") },
    ]);
    const expected = [{ resourceId: INNER, path: "index.ts" }];
    expect(listFiles(longLink, checkouts, ["src/index.ts"])).toEqual(expected);
    expect(listFiles(longLink, checkouts, [join(cwd, "src", "index.ts")])).toEqual(expected);
    expect(listFiles(longLink, checkouts, [join(longLink, "src", "index.ts")])).toEqual(expected);
  });

  it("finds a deleted file in a directory that is gone too, by its nearest existing ancestor", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(listFiles(cwd, checkouts, ["removed/dir/gone.ts"])).toEqual([
      { resourceId: REPO, path: "removed/dir/gone.ts" },
    ]);
  });

  it("stops at 256 files and counts the paths it did not look at", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    const paths = Array.from({ length: 300 }, (_, index) => `gen/${index}.ts`);
    const converted = convertEditedFiles(cwd, checkouts, [...paths, ...paths]);
    expect(converted.files).toHaveLength(256);
    expect(converted.unchecked).toBe(44);
  });

  it("reports no unchecked paths when every path was looked at", () => {
    const { cwd, checkouts } = buildRepo(createRoot());
    expect(convertEditedFiles(cwd, checkouts, ["a.ts", "a.ts"])).toEqual({
      files: [{ resourceId: REPO, path: "a.ts" }],
      unchecked: 0,
    });
  });
});

describe("readDetailPaths", () => {
  it("reads `path` and `paths`, ignoring what is not a string", () => {
    expect(readDetailPaths({ path: "a.ts", paths: ["b.ts", 3, null, "c.ts"] })).toEqual([
      "a.ts",
      "b.ts",
      "c.ts",
    ]);
  });

  it("reads nothing from a detail of another shape", () => {
    expect(readDetailPaths(undefined)).toEqual([]);
    expect(readDetailPaths("a.ts")).toEqual([]);
    expect(readDetailPaths({ path: 1, paths: "b.ts" })).toEqual([]);
  });
});
