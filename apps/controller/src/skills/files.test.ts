import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { computeSkillRevisionHash, type SkillFile } from "@hercule/protocol";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import {
  buildSkillRevisionFolder,
  buildSkillsFolder,
  readRevisionFiles,
  SkillFiles,
  SkillFilesLayer,
  SkillPathsCollide,
  sweepSkillFolders,
  writeFolderFiles,
} from "./files";

type Deps = SkillFiles | SqlClient.SqlClient | HerculeHome;

const AT = "2026-10-18T00:00:00.000Z";
const NAMED_HASH = "a".repeat(64);
const UNNAMED_HASH = "b".repeat(64);

let homes: Array<string> = [];

/** Whether the file system of the temp folder tells `x` and `X` apart. */
const isCaseSensitive = (() => {
  const probe = mkdtempSync(join(tmpdir(), "hercule-case-"));
  try {
    writeFileSync(join(probe, "x"), "");
    return !existsSync(join(probe, "X"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  homes = [];
});

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) => {
  const home = mkdtempSync(join(tmpdir(), "hercule-skill-files-"));
  homes.push(home);
  return Effect.runPromise(
    Effect.provide(
      effect,
      SkillFilesLayer.pipe(
        Layer.provideMerge(TestDatabase),
        Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
      ),
    ),
  );
};

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const FILES: ReadonlyArray<SkillFile> = [
  {
    path: "SKILL.md",
    mode: "644",
    content: encode("---\nname: teach\ndescription: Teaches.\n---\n"),
  },
  { path: "scripts/run.sh", mode: "755", content: encode("#!/bin/sh\n") },
];

/** Inserts a Skill with one revision of this hash, so a row names the hash. */
const nameHash = (hash: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO skills (id, name, source, created_at, created_by, updated_at, updated_by)
        VALUES (randomblob(16), ${`skill-${hash.slice(0, 4)}`}, '{"kind":"upload"}',
                ${AT}, 'user', ${AT}, 'user')`;
      yield* sql`
        INSERT INTO skill_revisions
          (skill_id, hash, origin, file_count, size_bytes, description, created_at, created_by)
        SELECT id, ${hash}, 'import', 1, 10, 'A skill.', ${AT}, 'user'
        FROM skills WHERE name = ${`skill-${hash.slice(0, 4)}`}`;
    }),
  );

const readFolder = (hash: string) =>
  Effect.map(HerculeHome, ({ dataDir }) => buildSkillRevisionFolder(dataDir, hash));

const readSkillsFolder = Effect.map(HerculeHome, ({ dataDir }) => buildSkillsFolder(dataDir));

/** A commit that stores nothing and answers `answer`. */
const commitNothing = <A>(answer: A, deletedHashes: ReadonlyArray<string> = []) =>
  Effect.succeed({ answer, deletedHashes });

describe("SkillFiles.publish", () => {
  it("writes the folder with modes 644 and 755 whatever the umask, and leaves no temp folder", async () => {
    const previous = process.umask(0o077);
    try {
      const outcome = await run(
        Effect.gen(function* () {
          const files = yield* SkillFiles;
          const answer = yield* files.publish(
            { revisionHash: NAMED_HASH, files: FILES },
            commitNothing("done"),
          );
          const folder = yield* readFolder(NAMED_HASH);
          return {
            answer,
            skillMdMode: statSync(join(folder, "SKILL.md")).mode & 0o777,
            scriptMode: statSync(join(folder, "scripts/run.sh")).mode & 0o777,
            entries: readdirSync(yield* readSkillsFolder),
          };
        }),
      );
      expect(outcome.answer).toBe("done");
      expect(outcome.skillMdMode).toBe(0o644);
      expect(outcome.scriptMode).toBe(0o755);
      expect(outcome.entries).toEqual([NAMED_HASH]);
    } finally {
      process.umask(previous);
    }
  });

  it("reuses a hash folder that already exists", async () => {
    const content = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        const folder = yield* readFolder(NAMED_HASH);
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, "SKILL.md"), "already here");
        yield* files.publish({ revisionHash: NAMED_HASH, files: FILES }, commitNothing(null));
        return readdirSync(folder);
      }),
    );
    expect(content).toEqual(["SKILL.md"]);
  });

  it("removes the folder of a failed commit unless a row names its hash", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        yield* nameHash(NAMED_HASH);
        const failing = Effect.fail("refused" as const);
        const errors = yield* Effect.all([
          Effect.flip(files.publish({ revisionHash: NAMED_HASH, files: FILES }, failing)),
          Effect.flip(files.publish({ revisionHash: UNNAMED_HASH, files: FILES }, failing)),
        ]);
        return {
          errors,
          named: existsSync(yield* readFolder(NAMED_HASH)),
          unnamed: existsSync(yield* readFolder(UNNAMED_HASH)),
        };
      }),
    );
    expect(outcome).toEqual({ errors: ["refused", "refused"], named: true, unnamed: false });
  });

  it("removes the folders of the hashes a commit deleted, unless a row still names one", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        yield* nameHash(NAMED_HASH);
        mkdirSync(yield* readFolder(NAMED_HASH), { recursive: true });
        mkdirSync(yield* readFolder(UNNAMED_HASH), { recursive: true });
        const published = "c".repeat(64);
        yield* nameHash(published);
        yield* files.publish(
          { revisionHash: published, files: FILES },
          commitNothing(null, [NAMED_HASH, UNNAMED_HASH]),
        );
        return {
          named: existsSync(yield* readFolder(NAMED_HASH)),
          unnamed: existsSync(yield* readFolder(UNNAMED_HASH)),
          published: existsSync(yield* readFolder(published)),
        };
      }),
    );
    expect(outcome).toEqual({ named: true, unnamed: false, published: true });
  });

  it("holds the lock until its commit ends, so a cleanup waits for the row the commit stores", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        // The commit names the hash only once it is released; until then a
        // cleanup that did not wait would find no row and remove the folder.
        const commit = Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          yield* nameHash(NAMED_HASH);
          return { answer: null, deletedHashes: [] };
        });
        const publishing = yield* Effect.forkChild(
          files.publish({ revisionHash: NAMED_HASH, files: FILES }, commit),
        );
        yield* Deferred.await(started);
        const cleaning = yield* Effect.forkChild(files.removeDeletedRevisionFolders([NAMED_HASH]));
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(publishing);
        yield* Fiber.join(cleaning);
        return existsSync(yield* readFolder(NAMED_HASH));
      }),
    );
    expect(outcome).toBe(true);
  });
});

describe("buildSkillRevisionFolder", () => {
  it("throws for a hash that is not 64 lowercase hex characters", () => {
    expect(() => buildSkillRevisionFolder("/data", "../../etc")).toThrow(
      "a Skill Revision hash must be 64 lowercase hex characters, not `../../etc`",
    );
    expect(() => buildSkillRevisionFolder("/data", "A".repeat(64))).toThrow();
  });
});

describe("writeFolderFiles", () => {
  it.skipIf(isCaseSensitive)(
    "refuses two paths the file system treats as one, naming both, and keeps the first file",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "hercule-skill-files-"));
      homes.push(home);
      const folder = join(home, "folder");
      const error = await Effect.runPromise(
        Effect.flip(
          writeFolderFiles(folder, [
            { path: "a.md", mode: "644", content: encode("lower") },
            { path: "A.md", mode: "644", content: encode("upper") },
          ]),
        ),
      );
      expect(error).toBeInstanceOf(SkillPathsCollide);
      expect(error.message).toBe(
        "`a.md` and `A.md` are one file on this machine's file system, which does not tell their names apart. Rename one of them so the names differ by more than letter case.",
      );
      expect(readFileSync(join(folder, "a.md"), "utf8")).toBe("lower");
    },
  );
});

describe("readRevisionFiles", () => {
  it("reads a published folder back into the files its hash was computed from", async () => {
    const { hash, recomputed, listed } = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        const hash = yield* computeSkillRevisionHash(FILES);
        yield* files.publish({ revisionHash: hash, files: FILES }, commitNothing(null));
        const read = yield* readRevisionFiles((yield* HerculeHome).dataDir, hash);
        return {
          hash,
          recomputed: yield* computeSkillRevisionHash(read),
          listed: yield* files.listFiles(hash),
        };
      }),
    );
    expect(recomputed).toBe(hash);
    expect(listed).toEqual([
      { path: "SKILL.md", mode: "644", sizeBytes: FILES[0]?.content.byteLength },
      { path: "scripts/run.sh", mode: "755", sizeBytes: FILES[1]?.content.byteLength },
    ]);
  });
});

describe("sweepSkillFolders", () => {
  it("removes temp folders and hash folders no row names, and leaves everything else", async () => {
    const left = await run(
      Effect.gen(function* () {
        yield* nameHash(NAMED_HASH);
        const directory = yield* readSkillsFolder;
        for (const name of [".tmp-1234", NAMED_HASH, UNNAMED_HASH, "notes"]) {
          mkdirSync(join(directory, name), { recursive: true });
        }
        yield* sweepSkillFolders;
        return readdirSync(directory).sort();
      }),
    );
    expect(left).toEqual([NAMED_HASH, "notes"]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "goes on past a folder it cannot remove, and removes the others",
    async () => {
      // A folder whose subfolder has no write permission cannot be removed:
      // the files inside the subfolder cannot be unlinked.
      const locked = join("a".repeat(64), "locked");
      const left = await run(
        Effect.gen(function* () {
          const directory = yield* readSkillsFolder;
          // The other folders sort on both sides of the locked one.
          for (const name of [".tmp-1", locked, UNNAMED_HASH]) {
            mkdirSync(join(directory, name), { recursive: true });
          }
          writeFileSync(join(directory, locked, "file"), "");
          chmodSync(join(directory, locked), 0o500);
          try {
            yield* sweepSkillFolders;
            return readdirSync(directory).sort();
          } finally {
            chmodSync(join(directory, locked), 0o700);
          }
        }),
      );
      expect(left).toEqual(["a".repeat(64)]);
    },
  );

  it("does nothing when the skills folder does not exist", async () => {
    await expect(run(sweepSkillFolders)).resolves.toBeUndefined();
  });
});
