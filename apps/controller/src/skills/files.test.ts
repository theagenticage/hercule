import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { buildSkillArchive, type SkillFile } from "@hercule/protocol";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import {
  buildSkillArchivePath,
  buildSkillsFolder,
  SkillFiles,
  SkillFilesLayer,
  sweepSkillArchives,
} from "./files";

type Deps = SkillFiles | SqlClient.SqlClient | HerculeHome;

// A test sets `heldRemoval` to keep the removal of one path waiting until it
// is released, so the test can act while the file system is still removing.
const removals = vi.hoisted(() => ({
  heldRemoval: undefined as
    | {
        readonly path: string;
        readonly started: () => void;
        readonly released: Promise<void>;
        readonly ended: () => void;
      }
    | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const held = removals.heldRemoval;
      if (held === undefined || args[0] !== held.path) return actual.rm(...args);
      removals.heldRemoval = undefined;
      held.started();
      await held.released;
      try {
        return await actual.rm(...args);
      } finally {
        held.ended();
      }
    },
  };
});

const AT = "2026-10-18T00:00:00.000Z";
const NAMED_HASH = "a".repeat(64);
const UNNAMED_HASH = "b".repeat(64);

let homes: Array<string> = [];

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

const readArchivePath = (hash: string) =>
  Effect.map(HerculeHome, ({ dataDir }) => buildSkillArchivePath(dataDir, hash));

const readSkillsFolder = Effect.map(HerculeHome, ({ dataDir }) => buildSkillsFolder(dataDir));

/** A commit that stores nothing and answers `answer`. */
const commitNothing = <A>(answer: A, deletedHashes: ReadonlyArray<string> = []) =>
  Effect.succeed({ answer, deletedHashes });

describe("SkillFiles.publish", () => {
  it("writes the archive of the files under the hash, and leaves no temp file", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        const answer = yield* files.publish(
          { revisionHash: NAMED_HASH, files: FILES },
          commitNothing("done"),
        );
        return {
          answer,
          stored: readFileSync(yield* readArchivePath(NAMED_HASH)),
          entries: readdirSync(yield* readSkillsFolder),
        };
      }),
    );
    expect(outcome.answer).toBe("done");
    expect(new Uint8Array(outcome.stored)).toEqual(
      await Effect.runPromise(buildSkillArchive(FILES)),
    );
    expect(outcome.entries).toEqual([`${NAMED_HASH}.tar`]);
  });

  it("reuses an archive that already exists under the hash", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        const path = yield* readArchivePath(NAMED_HASH);
        mkdirSync(yield* readSkillsFolder, { recursive: true });
        writeFileSync(path, "already here");
        yield* files.publish({ revisionHash: NAMED_HASH, files: FILES }, commitNothing(null));
        return {
          content: readFileSync(path, "utf8"),
          entries: readdirSync(yield* readSkillsFolder),
        };
      }),
    );
    expect(outcome).toEqual({ content: "already here", entries: [`${NAMED_HASH}.tar`] });
  });

  it("removes the archive of a failed commit unless a row names its hash", async () => {
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
          named: existsSync(yield* readArchivePath(NAMED_HASH)),
          unnamed: existsSync(yield* readArchivePath(UNNAMED_HASH)),
        };
      }),
    );
    expect(outcome).toEqual({ errors: ["refused", "refused"], named: true, unnamed: false });
  });

  it("removes the archives of the hashes a commit deleted, unless a row still names one", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        yield* nameHash(NAMED_HASH);
        mkdirSync(yield* readSkillsFolder, { recursive: true });
        writeFileSync(yield* readArchivePath(NAMED_HASH), "");
        writeFileSync(yield* readArchivePath(UNNAMED_HASH), "");
        const published = "c".repeat(64);
        yield* nameHash(published);
        yield* files.publish(
          { revisionHash: published, files: FILES },
          commitNothing(null, [NAMED_HASH, UNNAMED_HASH]),
        );
        return {
          named: existsSync(yield* readArchivePath(NAMED_HASH)),
          unnamed: existsSync(yield* readArchivePath(UNNAMED_HASH)),
          published: existsSync(yield* readArchivePath(published)),
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
        // cleanup that did not wait would find no row and remove the archive.
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
        const cleaning = yield* Effect.forkChild(files.removeDeletedRevisionArchives([NAMED_HASH]));
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(publishing);
        yield* Fiber.join(cleaning);
        return existsSync(yield* readArchivePath(NAMED_HASH));
      }),
    );
    expect(outcome).toBe(true);
  });
});

describe("SkillFiles.removeDeletedRevisionArchives", () => {
  it("keeps the lock until a removal it started ends, even when its fiber is interrupted", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        const path = yield* readArchivePath(UNNAMED_HASH);
        yield* files.publish({ revisionHash: UNNAMED_HASH, files: FILES }, commitNothing(null));
        const started = Promise.withResolvers<void>();
        const released = Promise.withResolvers<void>();
        const ended = Promise.withResolvers<void>();
        removals.heldRemoval = {
          path,
          started: started.resolve,
          released: released.promise,
          ended: ended.resolve,
        };

        const cleaning = yield* Effect.forkChild(
          files.removeDeletedRevisionArchives([UNNAMED_HASH]),
        );
        yield* Effect.promise(() => started.promise);
        // Not awaited: the interrupt ends only once the removal has.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(cleaning));
        // A publish of the same hash that took the lock now would reuse the
        // archive being removed, and its row would name a missing file.
        const commit = Effect.as(nameHash(UNNAMED_HASH), { answer: null, deletedHashes: [] });
        const publishing = yield* Effect.forkChild(
          files.publish({ revisionHash: UNNAMED_HASH, files: FILES }, commit),
        );
        yield* Effect.sleep("50 millis");
        released.resolve();
        yield* Effect.promise(() => ended.promise);
        yield* Fiber.join(interrupting);
        yield* Fiber.join(publishing);
        return existsSync(path);
      }),
    );
    expect(outcome).toBe(true);
  });
});

describe("buildSkillArchivePath", () => {
  it("throws for a hash that is not 64 lowercase hex characters", () => {
    expect(() => buildSkillArchivePath("/data", "../../etc")).toThrow(
      "a Skill Revision hash must be 64 lowercase hex characters, not `../../etc`",
    );
    expect(() => buildSkillArchivePath("/data", "A".repeat(64))).toThrow();
  });
});

describe("SkillFiles.readRevision", () => {
  it("lists a published revision's files without their content, and reads its SKILL.md", async () => {
    const revision = await run(
      Effect.gen(function* () {
        const files = yield* SkillFiles;
        yield* files.publish({ revisionHash: NAMED_HASH, files: FILES }, commitNothing(null));
        return yield* files.readRevision(NAMED_HASH);
      }),
    );
    expect(revision).toEqual({
      files: [
        { path: "SKILL.md", mode: "644", sizeBytes: FILES[0]?.content.byteLength },
        { path: "scripts/run.sh", mode: "755", sizeBytes: FILES[1]?.content.byteLength },
      ],
      skillMd: "---\nname: teach\ndescription: Teaches.\n---\n",
    });
  });

  it("fails with the read's ENOENT when the archive is missing", async () => {
    const error = await run(
      Effect.flip(Effect.flatMap(SkillFiles, (files) => files.readRevision(NAMED_HASH))),
    );
    expect(error.action).toBe("read");
    expect((error.cause as NodeJS.ErrnoException).code).toBe("ENOENT");
  });
});

describe("sweepSkillArchives", () => {
  it("removes temp files and archives no row names, and leaves everything else", async () => {
    const left = await run(
      Effect.gen(function* () {
        yield* nameHash(NAMED_HASH);
        const directory = yield* readSkillsFolder;
        mkdirSync(directory, { recursive: true });
        for (const name of [".tmp-1234.tar", `${NAMED_HASH}.tar`, `${UNNAMED_HASH}.tar`, "notes"]) {
          writeFileSync(join(directory, name), "");
        }
        yield* sweepSkillArchives;
        return readdirSync(directory).sort();
      }),
    );
    expect(left).toEqual([`${NAMED_HASH}.tar`, "notes"]);
  });

  it("goes on past a file it cannot remove, and removes the others", async () => {
    // A folder is not removed without `recursive`, so a folder named like
    // an archive stands in for a file the sweep cannot remove.
    const stuck = `${"c".repeat(64)}.tar`;
    const left = await run(
      Effect.gen(function* () {
        const directory = yield* readSkillsFolder;
        // The other files sort on both sides of the stuck one.
        mkdirSync(join(directory, stuck), { recursive: true });
        writeFileSync(join(directory, ".tmp-1.tar"), "");
        writeFileSync(join(directory, `${UNNAMED_HASH}.tar`), "");
        yield* sweepSkillArchives;
        return readdirSync(directory).sort();
      }),
    );
    expect(left).toEqual([stuck]);
  });

  it("does nothing when the skills folder does not exist", async () => {
    await expect(run(sweepSkillArchives)).resolves.toBeUndefined();
  });
});
