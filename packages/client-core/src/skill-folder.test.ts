import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { MAX_SKILL_BYTES } from "@hercule/contract";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSkillFolders, buildSkillFolderArchive } from "./skill-folder";

/** One regular file in a ustar archive, as the test reads it back. */
interface ArchivedFile {
  readonly path: string;
  readonly mode: string;
  readonly text: string;
}

/**
 * Lists the files in a ustar archive. Reads only the header fields the reader
 * sets: name, prefix, mode and size.
 */
const listArchive = (archive: Uint8Array): Array<ArchivedFile> => {
  const decoder = new TextDecoder();
  const readText = (start: number, length: number) =>
    decoder.decode(archive.subarray(start, start + length)).replace(/\0.*$/s, "");
  const files: Array<ArchivedFile> = [];
  let offset = 0;
  while (offset + 512 <= archive.length && archive[offset] !== 0) {
    const name = readText(offset, 100);
    const prefix = readText(offset + 345, 155);
    const size = Number.parseInt(readText(offset + 124, 12).trim(), 8);
    const mode = Number.parseInt(readText(offset + 100, 8).trim(), 8)
      .toString(8)
      .padStart(3, "0");
    const content = archive.subarray(offset + 512, offset + 512 + size);
    files.push({ path: prefix ? `${prefix}/${name}` : name, mode, text: decoder.decode(content) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
};

/** Writes `content` to `file`, creating its folders. */
const writeTestFile = async (file: string, content: string) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
};

/** Reads the skill folder and lists its archive. */
const readArchive = async (folder: string) =>
  listArchive(await Effect.runPromise(buildSkillFolderArchive(folder)));

/** Reads the skill folder and returns the error it fails with. */
const readRefusal = (folder: string) =>
  Effect.runPromise(Effect.flip(buildSkillFolderArchive(folder)));

let root: string;

beforeEach(async () => {
  // The real path, because macOS reaches the temporary folder through a link.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "skill-folder-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("findSkillFolders", () => {
  it("finds the picked folder as the one skill when it holds a SKILL.md", async () => {
    await writeTestFile(path.join(root, "grilling/SKILL.md"), "# Grilling");
    await writeTestFile(path.join(root, "grilling/sub/SKILL.md"), "# Not a skill of its own");

    const found = await Effect.runPromise(findSkillFolders(path.join(root, "grilling")));

    expect(found.folder).toBe(path.join(root, "grilling"));
    expect(found.skills).toEqual([
      { name: "grilling", folder: path.join(root, "grilling"), source: null },
    ]);
  });

  it("finds every subfolder holding a SKILL.md in a folder of skills, sorted by name", async () => {
    await writeTestFile(path.join(root, "skills/zeta/SKILL.md"), "z");
    await writeTestFile(path.join(root, "skills/alpha/SKILL.md"), "a");
    await writeTestFile(path.join(root, "skills/notes/README.md"), "not a skill");
    await writeTestFile(path.join(root, "skills/SKILL.txt"), "a file, not a folder");

    const found = await Effect.runPromise(findSkillFolders(path.join(root, "skills")));

    expect(found.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"]);
    expect(found.skills[0]?.folder).toBe(path.join(root, "skills/alpha"));
  });

  it("names a linked skill by the link and finds the lock file from the link's side", async () => {
    // The layout `npx skills` makes: the skill lives elsewhere and is linked in.
    await writeTestFile(path.join(root, "store/grilling/SKILL.md"), "# Grilling");
    await mkdir(path.join(root, "agents/skills"), { recursive: true });
    await symlink(path.join(root, "store/grilling"), path.join(root, "agents/skills/grill"));
    await writeTestFile(
      path.join(root, "agents/.skill-lock.json"),
      JSON.stringify({
        skills: {
          grill: { source: "acme/skills", sourceType: "github", skillPath: "grill/SKILL.md" },
        },
      }),
    );

    const ofFolder = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));
    const ofLink = await Effect.runPromise(
      findSkillFolders(path.join(root, "agents/skills/grill")),
    );

    expect(ofFolder.skills).toEqual([
      {
        name: "grill",
        folder: path.join(root, "agents/skills/grill"),
        source: { repo: "acme/skills", path: "grill" },
      },
    ]);
    expect(ofLink.folder).toBe(path.join(root, "store/grilling"));
    expect(ofLink.skills).toEqual([
      {
        name: "grill",
        folder: path.join(root, "agents/skills/grill"),
        source: { repo: "acme/skills", path: "grill" },
      },
    ]);
  });

  it("refuses a folder that does not exist, and a file", async () => {
    await writeTestFile(path.join(root, "file.md"), "x");

    const missing = await Effect.runPromise(
      Effect.flip(findSkillFolders(path.join(root, "missing"))),
    );
    const file = await Effect.runPromise(Effect.flip(findSkillFolders(path.join(root, "file.md"))));

    expect(missing.reason).toBe(
      `\`${path.join(root, "missing")}\` cannot be read: it does not exist.`,
    );
    expect(file.reason).toBe(`\`${path.join(root, "file.md")}\` is not a folder.`);
  });

  it("writes the home folder as ~ in the paths it shows", async () => {
    // Bun reads the home folder once, so the test cannot point it elsewhere.
    // A missing folder under the real home shows the path without writing there.
    const missing = `hercule-test-missing-${path.basename(root)}`;
    await writeTestFile(path.join(root, "skills/grilling/SKILL.md"), "x");

    const found = await Effect.runPromise(findSkillFolders(path.join(root, "skills")));
    const refusal = await Effect.runPromise(
      Effect.flip(findSkillFolders(path.join(homedir(), missing, "skills"))),
    );

    expect(found.displayPath).toBe(path.join(root, "skills"));
    expect(refusal.reason).toBe(`\`~/${missing}/skills\` cannot be read: it does not exist.`);
  });

  describe("the lock file", () => {
    beforeEach(async () => {
      await writeTestFile(path.join(root, "agents/skills/grilling/SKILL.md"), "g");
      await writeTestFile(path.join(root, "agents/skills/local/SKILL.md"), "l");
    });

    /** Writes the lock file beside the skills folder, as the `skills` tool keeps it. */
    const writeLock = (content: string) =>
      writeTestFile(path.join(root, "agents/.skill-lock.json"), content);

    it("gives a GitHub source to a github entry, and none to any other entry", async () => {
      await writeLock(
        JSON.stringify({
          version: 3,
          skills: {
            grilling: {
              source: "mattpocock/skills",
              sourceType: "github",
              sourceUrl: "https://github.com/mattpocock/skills.git",
              skillPath: "skills/engineering/grilling/SKILL.md",
              skillFolderHash: "344e3efc88ee60663b2e989555c2efdb548fbd42",
            },
            local: { source: "/somewhere", sourceType: "local", skillPath: "local/SKILL.md" },
          },
        }),
      );

      const folder = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));
      const single = await Effect.runPromise(
        findSkillFolders(path.join(root, "agents/skills/grilling")),
      );

      expect(folder.lockFileProblem).toBeNull();
      expect(folder.skills.map((skill) => skill.source)).toEqual([
        { repo: "mattpocock/skills", path: "skills/engineering/grilling" },
        null,
      ]);
      expect(single.skills[0]?.source).toEqual({
        repo: "mattpocock/skills",
        path: "skills/engineering/grilling",
      });
    });

    it("ignores an entry whose source the controller would refuse, naming it", async () => {
      await writeLock(
        JSON.stringify({
          skills: {
            grilling: {
              source: "https://github.com/mattpocock/skills",
              sourceType: "github",
              skillPath: "skills/grilling/SKILL.md",
            },
            local: {
              source: "mattpocock/skills",
              sourceType: "github",
              skillPath: "local/SKILL.md",
            },
          },
        }),
      );

      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.skills.map((skill) => skill.source)).toEqual([
        null,
        { repo: "mattpocock/skills", path: "local" },
      ]);
      expect(found.lockFileProblem).toBe(
        `Ignored the entries for \`grilling\` in \`${path.join(root, "agents/.skill-lock.json")}\` because their GitHub source is not a repository and folder Hercule accepts, so those skills get no GitHub source.`,
      );
    });

    it("prefers the nearest lock file", async () => {
      await writeLock(JSON.stringify({ skills: {} }));
      await writeTestFile(
        path.join(root, "agents/skills/.skill-lock.json"),
        JSON.stringify({
          skills: {
            local: { source: "acme/local", sourceType: "github", skillPath: "SKILL.md" },
          },
        }),
      );

      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.skills.map((skill) => skill.source)).toEqual([
        null,
        { repo: "acme/local", path: "" },
      ]);
    });

    it("gives no source and reports no problem when there is no lock file", async () => {
      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.lockFileProblem).toBeNull();
      expect(found.skills.map((skill) => skill.source)).toEqual([null, null]);
    });

    it("ignores a lock file that is not JSON, naming it in one line", async () => {
      await writeLock("{ not json");

      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.lockFileProblem).toBe(
        `Ignored \`${path.join(root, "agents/.skill-lock.json")}\` because it is not valid JSON, so no skill gets a GitHub source from it.`,
      );
      expect(found.skills.map((skill) => skill.source)).toEqual([null, null]);
    });

    it("ignores a lock file of the wrong shape", async () => {
      await writeLock(JSON.stringify({ skills: [1, 2] }));

      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.lockFileProblem).toContain("does not hold a `skills` list");
    });

    it("ignores a lock file that is a named pipe, without waiting for it", async () => {
      execFileSync("mkfifo", [path.join(root, "agents/.skill-lock.json")]);

      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.lockFileProblem).toBe(
        `Ignored \`${path.join(root, "agents/.skill-lock.json")}\` because it is a named pipe, not a file, so no skill gets a GitHub source from it.`,
      );
    });

    it("ignores a lock file over 1 MiB without reading it", async () => {
      await writeLock("");
      await truncate(path.join(root, "agents/.skill-lock.json"), 1024 * 1024 + 1);

      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.lockFileProblem).toBe(
        `Ignored \`${path.join(root, "agents/.skill-lock.json")}\` because it is over 1 MiB, far larger than a lock file the \`skills\` tool writes, so no skill gets a GitHub source from it.`,
      );
    });

    it("reads a lock file that is a link", async () => {
      await writeTestFile(
        path.join(root, "dotfiles/skill-lock.json"),
        JSON.stringify({
          skills: { local: { source: "acme/local", sourceType: "github", skillPath: "SKILL.md" } },
        }),
      );
      await symlink(
        path.join(root, "dotfiles/skill-lock.json"),
        path.join(root, "agents/.skill-lock.json"),
      );

      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.lockFileProblem).toBeNull();
      expect(found.skills[1]?.source).toEqual({ repo: "acme/local", path: "" });
    });

    it.skipIf(process.getuid?.() === 0)("ignores a lock file it cannot read", async () => {
      await writeLock("{}");
      await chmod(path.join(root, "agents/.skill-lock.json"), 0o000);

      const found = await Effect.runPromise(findSkillFolders(path.join(root, "agents/skills")));

      expect(found.lockFileProblem).toBe(
        `Ignored \`${path.join(root, "agents/.skill-lock.json")}\` because it cannot be read: permission was denied, so no skill gets a GitHub source from it.`,
      );
    });
  });
});

describe("buildSkillFolderArchive", () => {
  it("archives every file with its content, skipping junk and empty folders", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "# Grilling");
    await writeTestFile(path.join(skill, "teach/notes.md"), "notes");
    await writeTestFile(path.join(skill, ".DS_Store"), "junk");
    await writeTestFile(path.join(skill, "teach/Thumbs.db"), "junk");
    await writeTestFile(path.join(skill, ".git/config"), "junk");
    await writeTestFile(path.join(skill, "teach/.git"), "gitdir: elsewhere");
    await mkdir(path.join(skill, "empty/deeper"), { recursive: true });

    expect(await readArchive(skill)).toEqual([
      { path: "SKILL.md", mode: "644", text: "# Grilling" },
      { path: "teach/notes.md", mode: "644", text: "notes" },
    ]);
  });

  it("keeps the owner's execute bit as mode 755", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    await writeTestFile(path.join(skill, "run.sh"), "#!/bin/sh");
    await chmod(path.join(skill, "run.sh"), 0o744);
    await chmod(path.join(skill, "SKILL.md"), 0o611);

    const files = await readArchive(skill);

    expect(files.map(({ path, mode }) => ({ path, mode }))).toEqual([
      { path: "SKILL.md", mode: "644" },
      { path: "run.sh", mode: "755" },
    ]);
  });

  it("reads a skill folder that is itself a link", async () => {
    await writeTestFile(path.join(root, "store/grilling/SKILL.md"), "# Grilling");
    await symlink(path.join(root, "store/grilling"), path.join(root, "grilling"));

    expect(await readArchive(path.join(root, "grilling"))).toEqual([
      { path: "SKILL.md", mode: "644", text: "# Grilling" },
    ]);
  });

  it("names a linked skill folder's files by the link's name", async () => {
    await writeTestFile(path.join(root, "store/grilling-abc/SKILL.md"), "x");
    await symlink(path.join(root, "secret"), path.join(root, "store/grilling-abc/shared"));
    await symlink(path.join(root, "store/grilling-abc"), path.join(root, "grilling"));
    await writeTestFile(path.join(root, "secret"), "a key");

    const refusal = await readRefusal(path.join(root, "grilling"));

    expect("reason" in refusal ? refusal.reason : refusal._tag).toMatch(
      /^`grilling\/shared` points outside/,
    );
  });

  it("puts a link's target inside the folder in the archive under the link's path", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "# Grilling");
    await writeTestFile(path.join(skill, "teach/notes.md"), "notes");
    await symlink("teach", path.join(skill, "alias"));
    await symlink("../SKILL.md", path.join(skill, "teach/readme.md"));

    expect(await readArchive(skill)).toEqual([
      { path: "SKILL.md", mode: "644", text: "# Grilling" },
      { path: "alias/notes.md", mode: "644", text: "notes" },
      { path: "alias/readme.md", mode: "644", text: "# Grilling" },
      { path: "teach/notes.md", mode: "644", text: "notes" },
      { path: "teach/readme.md", mode: "644", text: "# Grilling" },
    ]);
  });

  it("refuses a link that points outside the skill's folder, naming the link", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    await writeTestFile(path.join(root, "secret"), "a key");
    await mkdir(path.join(skill, "teach"));
    await symlink(path.join(root, "secret"), path.join(skill, "teach/shared"));

    const refusal = await readRefusal(skill);

    expect(refusal).toMatchObject({
      _tag: "SkillFolderUnreadable",
      reason:
        "`grilling/teach/shared` points outside the skill's folder. A skill holds only its own files; copy what it needs into its folder.",
    });
  });

  it("refuses a link to a folder that contains it", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    await mkdir(path.join(skill, "teach"));
    await symlink("..", path.join(skill, "teach/loop"));

    expect(await readRefusal(skill)).toMatchObject({
      reason:
        "`grilling/teach/loop` points to a folder that contains it, which makes a cycle of links. Remove the link from the skill's folder.",
    });
  });

  it("refuses links that point to each other", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    await symlink("b", path.join(skill, "a"));
    await symlink("a", path.join(skill, "b"));

    const refusal = await readRefusal(skill);

    // Which of the two links the walk meets first depends on the folder listing.
    expect("reason" in refusal ? refusal.reason : refusal._tag).toMatch(
      /^`grilling\/[ab]` is part of a cycle of symbolic links\. Remove the link from the skill's folder\.$/,
    );
  });

  it("reads a folder that many links reach once, so links cannot make the walk grow", async () => {
    // Each level holds the next one and a link to it, so the walk meets 2^24
    // paths to the deepest folder. Reading each folder once takes 24 steps.
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    let level = skill;
    for (let depth = 0; depth < 24; depth += 1) {
      await mkdir(path.join(level, "a"));
      await symlink("a", path.join(level, "b"));
      level = path.join(level, "a");
    }

    expect(await readArchive(skill)).toEqual([{ path: "SKILL.md", mode: "644", text: "x" }]);
  });

  it("refuses a skill whose links put more than 1,000 files in the archive", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    let level = skill;
    for (let depth = 0; depth < 10; depth += 1) {
      await mkdir(path.join(level, "a"));
      await symlink("a", path.join(level, "b"));
      level = path.join(level, "a");
    }
    // 2^10 paths lead to this one file.
    await writeFile(path.join(level, "notes.md"), "notes");

    expect(await readRefusal(skill)).toMatchObject({
      reason:
        "`grilling` has more than 1,000 files. A skill holds at most 1,000; remove the files it does not need.",
    });
  });

  it("refuses a skill of more than 1,000 files", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    await Promise.all(
      Array.from({ length: 1000 }, (_, index) =>
        writeFile(path.join(skill, `f${String(index)}.md`), ""),
      ),
    );

    expect(await readRefusal(skill)).toMatchObject({
      reason:
        "`grilling` has more than 1,000 files. A skill holds at most 1,000; remove the files it does not need.",
    });
  });

  it("refuses a link whose target does not exist", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    await symlink("gone.md", path.join(skill, "notes.md"));

    expect(await readRefusal(skill)).toMatchObject({
      reason:
        "`grilling/notes.md` is a symbolic link to a file that does not exist. Remove the link, or copy the file it should point to into the skill's folder.",
    });
  });

  it("refuses a socket", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path.join(skill, "agent.sock"), resolve));
    try {
      expect(await readRefusal(skill)).toMatchObject({
        reason:
          "`grilling/agent.sock` is a socket, not a file. A skill holds only files and folders; remove it from the skill's folder.",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses a path too long for a tar archive, naming it from the skill's folder", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    const name = `${"n".repeat(101)}.md`;
    await writeTestFile(path.join(skill, name), "x");

    expect(await readRefusal(skill)).toMatchObject({
      reason: `\`grilling/${name}\` is too long for a tar archive. Shorten its folder names or its file name.`,
    });
  });

  it("refuses a skill whose archive would be over the limit", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    // Exactly the limit in content alone, so the headers push the archive over it.
    await writeFile(path.join(skill, "big.bin"), new Uint8Array(MAX_SKILL_BYTES));

    expect(await readRefusal(skill)).toMatchObject({ _tag: "SkillTooLarge", name: "grilling" });
  });

  it("stops before reading a file that would put the archive over the limit", async () => {
    const skill = path.join(root, "grilling");
    await writeTestFile(path.join(skill, "SKILL.md"), "x");
    // A sparse file: it takes no disk space, but reading it would take a gibibyte of memory.
    await writeFile(path.join(skill, "huge.bin"), "");
    await truncate(path.join(skill, "huge.bin"), 1024 ** 3);

    expect(await readRefusal(skill)).toMatchObject({ _tag: "SkillTooLarge", name: "grilling" });
  });
});
