import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildSkillArchive,
  compareSkillPaths,
  computeSkillArchiveByteLength,
  computeSkillRevisionHash,
  readSkillArchive,
  SkillRevisionHash,
  SkillArchiveUnreadable,
  SkillPathTooLong,
  splitUstarPath,
  type SkillFile,
} from "./skills";

const text = (value: string) => new TextEncoder().encode(value);

/** The two files of the worked example in spec 02, Skill Revision, "The hash". */
const demoFiles: ReadonlyArray<SkillFile> = [
  { path: "scripts/hi.sh", mode: "755", content: text("echo hi\n") },
  {
    path: "SKILL.md",
    mode: "644",
    content: text("---\nname: demo\ndescription: Says hi.\n---\nRun scripts/hi.sh.\n"),
  },
];

const sha256Hex = async (bytes: Uint8Array) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))).toString("hex");

const build = (files: ReadonlyArray<SkillFile>) => Effect.runSync(buildSkillArchive(files));

/** Returns the error `readSkillArchive` fails with; throws when it reads the bytes. */
const readFailure = (bytes: Uint8Array) => Effect.runSync(Effect.flip(readSkillArchive(bytes)));

/** A path of `length` bytes made of `a`s. */
const segment = (length: number) => "a".repeat(length);

describe("computeSkillRevisionHash", () => {
  it("hashes spec 02's worked example to the hash the spec gives", async () => {
    const [script, skillMd] = demoFiles;
    expect(await sha256Hex(skillMd!.content)).toBe(
      "d4aa7a22156451e0f0abfbff93eccca660e313b219ad7f73c536addd2110e88a",
    );
    expect(await sha256Hex(script!.content)).toBe(
      "ab08508fdf5ca4da5c4995987bc41c56c048aaa5eeb046417ae4049b7d40286e",
    );
    const hash = await Effect.runPromise(computeSkillRevisionHash(demoFiles));
    expect(hash).toBe("e72ed80069b9b0cf3e19a4972f35e5daf05df98ed98d4e8ee131a26e6b3f711e");
    expect(Schema.is(SkillRevisionHash)(hash)).toBe(true);
  });

  it("hashes a file's content that is a view into larger bytes as its own bytes", async () => {
    const larger = text("xx---\nname: demo\ndescription: Says hi.\n---\nRun scripts/hi.sh.\nyy");
    const view = larger.subarray(2, -2);
    const files = demoFiles.map((file) =>
      file.path === "SKILL.md" ? { ...file, content: view } : file,
    );
    expect(await Effect.runPromise(computeSkillRevisionHash(files))).toBe(
      "e72ed80069b9b0cf3e19a4972f35e5daf05df98ed98d4e8ee131a26e6b3f711e",
    );
  });

  it("depends on each file's mode", async () => {
    const executableSkillMd = demoFiles.map((file) => ({ ...file, mode: "755" as const }));
    expect(await Effect.runPromise(computeSkillRevisionHash(executableSkillMd))).not.toBe(
      await Effect.runPromise(computeSkillRevisionHash(demoFiles)),
    );
  });
});

describe("compareSkillPaths", () => {
  it("puts an upper-case path before a lower-case one, as their bytes do", () => {
    expect(["scripts/hi.sh", "SKILL.md"].sort(compareSkillPaths)).toEqual([
      "SKILL.md",
      "scripts/hi.sh",
    ]);
  });

  it("orders characters outside the Basic Multilingual Plane by their UTF-8 bytes", () => {
    // UTF-16 puts the emoji (surrogates from 0xD83D) before U+FF01; UTF-8 puts it after.
    expect(["\u{1F600}.md", "！.md", "é.md", "z.md"].sort(compareSkillPaths)).toEqual([
      "z.md",
      "é.md",
      "！.md",
      "\u{1F600}.md",
    ]);
  });

  it("puts a path before a longer path it starts", () => {
    expect(compareSkillPaths("a", "a/b")).toBeLessThan(0);
    expect(compareSkillPaths("a/b", "a/b")).toBe(0);
  });
});

describe("splitUstarPath", () => {
  it("keeps a path of 100 bytes whole in the name field", () => {
    expect(splitUstarPath(segment(100))).toEqual({ prefix: "", name: segment(100) });
  });

  it("splits a longer path at the last slash the prefix field can hold", () => {
    const path = `${segment(60)}/${segment(60)}/${segment(60)}`;
    expect(splitUstarPath(path)).toEqual({
      prefix: `${segment(60)}/${segment(60)}`,
      name: segment(60),
    });
  });

  it("keeps a leading U+FEFF in the prefix", () => {
    const path = `\uFEFF${segment(60)}/${segment(60)}`;
    expect(splitUstarPath(path)).toEqual({ prefix: `\uFEFF${segment(60)}`, name: segment(60) });
  });

  it("refuses a path that no split fits", () => {
    expect(splitUstarPath(segment(101))).toBeNull();
    expect(splitUstarPath(`${segment(156)}/${segment(10)}`)).toBeNull();
    expect(splitUstarPath(`${segment(10)}/${segment(101)}`)).toBeNull();
  });
});

describe("buildSkillArchive and readSkillArchive", () => {
  it("round-trips paths, modes and content, sorted by path", () => {
    const longPath = `reference/${segment(90)}/${segment(90)}.md`;
    const exactPath = segment(100);
    const files: ReadonlyArray<SkillFile> = [
      ...demoFiles,
      { path: longPath, mode: "644", content: text("long\n") },
      { path: exactPath, mode: "644", content: new Uint8Array(0) },
      { path: "docs/é.md", mode: "644", content: new Uint8Array(1500).fill(7) },
    ];
    const entries = Effect.runSync(readSkillArchive(build(files)));
    expect(entries.map(({ path, kind, mode }) => ({ path, kind, mode }))).toEqual(
      [...files]
        .sort((a, b) => compareSkillPaths(a.path, b.path))
        .map((file) => ({
          path: file.path,
          kind: "file",
          mode: file.mode === "755" ? 0o755 : 0o644,
        })),
    );
    for (const entry of entries) {
      expect(entry.content).toEqual(files.find((file) => file.path === entry.path)!.content);
    }
  });

  it("ends the archive with two zero blocks and builds the same bytes every time", () => {
    const archive = build(demoFiles);
    expect(archive.length % 512).toBe(0);
    expect(archive.subarray(-1024).every((byte) => byte === 0)).toBe(true);
    expect(build([...demoFiles].reverse())).toEqual(archive);
  });

  it("fails with the spec's message for a path too long for a ustar header", () => {
    const path = `${segment(10)}/${segment(101)}`;
    const error = Effect.runSync(
      Effect.flip(buildSkillArchive([{ path, mode: "644", content: new Uint8Array(0) }])),
    );
    expect(error).toBeInstanceOf(SkillPathTooLong);
    expect(error.path).toBe(path);
    expect(error.message).toBe(
      `\`${path}\` is too long for a tar archive. Shorten its folder names or its file name.`,
    );
  });
});

describe("computeSkillArchiveByteLength", () => {
  it.each([
    { shape: "no files", sizes: [] },
    { shape: "one empty file", sizes: [0] },
    { shape: "a file one byte short of a block", sizes: [511] },
    { shape: "a file of exactly one block", sizes: [512] },
    { shape: "a file one byte past a block", sizes: [513] },
    { shape: "several files in nested folders", sizes: [0, 1, 1500, 4096, 70_000] },
  ])("equals the length of the archive built from $shape", ({ sizes }) => {
    const files = sizes.map((size, index): SkillFile => ({
      path: `folder-${String(index % 2)}/file-${String(index)}`,
      mode: index % 2 === 0 ? "644" : "755",
      content: new Uint8Array(size),
    }));
    expect(computeSkillArchiveByteLength(sizes)).toBe(build(files).byteLength);
  });
});

describe("readSkillArchive", () => {
  it("reads an empty archive and one without its end marker", () => {
    expect(Effect.runSync(readSkillArchive(new Uint8Array(0)))).toEqual([]);
    const archive = build(demoFiles);
    expect(Effect.runSync(readSkillArchive(archive.subarray(0, -1024)))).toHaveLength(2);
  });

  it("keeps a byte order mark at the start of a path", () => {
    const path = "\ufeffnotes.md";
    const entries = Effect.runSync(
      readSkillArchive(build([{ path, mode: "644", content: text("") }])),
    );
    expect(entries.map((entry) => entry.path)).toEqual([path]);
  });

  it("refuses a header with a wrong checksum", () => {
    const archive = build(demoFiles);
    archive[0] = archive[0]! + 1;
    const error = readFailure(archive);
    expect(error).toBeInstanceOf(SkillArchiveUnreadable);
    expect(error.message).toContain("wrong checksum");
  });

  it("refuses an archive cut off in a header or in a file's content", () => {
    const archive = build(demoFiles);
    expect(readFailure(archive.subarray(0, 700)).message).toContain("cut off");
    expect(readFailure(archive.subarray(0, 300)).message).toContain("cut off");
  });

  it("refuses bytes that are not a ustar archive", () => {
    expect(readFailure(new Uint8Array(512).fill(1)).message).toContain("not a ustar");
  });

  it("refuses data after the end marker", () => {
    const archive = build(demoFiles);
    const padded = new Uint8Array(archive.length + 512);
    padded.set(archive);
    padded[padded.length - 1] = 1;
    expect(readFailure(padded).message).toContain("after its end marker");
  });
});

describe("the system tar", () => {
  const folders: Array<string> = [];
  const makeFolder = () => {
    const folder = mkdtempSync(join(tmpdir(), "skills-test-"));
    folders.push(folder);
    return folder;
  };
  // macOS's tar would add `._` entries for extended attributes without this.
  const tar = (args: ReadonlyArray<string>) => {
    const result = Bun.spawnSync(["tar", ...args], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString();
  };

  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  it("lists and extracts an archive the builder wrote", () => {
    const folder = makeFolder();
    const archivePath = join(folder, "skill.tar");
    const longPath = `reference/${segment(90)}/${segment(90)}.md`;
    writeFileSync(
      archivePath,
      build([...demoFiles, { path: longPath, mode: "644", content: text("long\n") }]),
    );
    expect(tar(["-tf", archivePath]).trim().split("\n")).toEqual([
      "SKILL.md",
      longPath,
      "scripts/hi.sh",
    ]);
    const extracted = join(folder, "out");
    mkdirSync(extracted);
    tar(["-xf", archivePath, "-C", extracted]);
    expect(readFileSync(join(extracted, "scripts/hi.sh"), "utf8")).toBe("echo hi\n");
    expect(readFileSync(join(extracted, longPath), "utf8")).toBe("long\n");
  });

  it("reads a directory and a symbolic link from an archive the system tar wrote", () => {
    const folder = makeFolder();
    const source = join(folder, "skill");
    mkdirSync(join(source, "docs"), { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "hi\n");
    symlinkSync("SKILL.md", join(source, "link"));
    const archivePath = join(folder, "skill.tar");
    tar(["--format", "ustar", "-cf", archivePath, "-C", source, "SKILL.md", "docs", "link"]);
    const entries = Effect.runSync(readSkillArchive(new Uint8Array(readFileSync(archivePath))));
    expect(entries.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "SKILL.md", kind: "file" },
      { path: "docs/", kind: "directory" },
      { path: "link", kind: "symlink" },
    ]);
    expect(new TextDecoder().decode(entries[0]!.content)).toBe("hi\n");
    expect(entries[2]!.content).toHaveLength(0);
  });
});
