import {
  existsSync,
  linkSync,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { buildHomePaths, type HomePaths } from "@hercule/home";
import {
  buildSkillArchive,
  computeSkillRevisionHash,
  MAX_SKILL_BYTES,
  type SkillFile,
} from "@hercule/protocol";
import { CurrentActor, type Actor } from "../actor";
import { HerculeHome } from "../config";
import { binaryVersion, openDatabase, openDatabaseCopy, runMigrations } from "../db";
import { AuditLogLayer } from "../events";
import { createMasterKey, openKeyStore, type SecurityRunner } from "../secrets";
import { buildSkillArchivePath, SkillService, SkillServiceLayer } from "../skills";
import { streamTransfer, TRANSFER_FORMAT_VERSION } from "./bundle";
import { encodeBase64Url } from "./crypto";
import { receiveTransfer, reserveHome } from "./receive";

/** The controller every transfer in this file comes from, and the one its preview showed. */
const CONTROLLER_ID = "0198e4b0-0000-7000-8000-000000000001";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hercule-promote-b-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A Skill Revision a test transfer carries: the hash its header names, and its archive. */
interface SentSkillRevision {
  readonly revisionHash: string;
  readonly archive: Uint8Array;
}

/**
 * Writes a transfer of the database at `database` to a file and returns its
 * path. It carries each of `skillRevisions` after the database.
 */
const writeTransferOf = async (
  database: string,
  schemaVersion: number,
  skillRevisions: ReadonlyArray<SentSkillRevision>,
): Promise<string> => {
  const header = {
    formatVersion: TRANSFER_FORMAT_VERSION,
    controllerId: CONTROLLER_ID,
    schemaVersion,
    salt: encodeBase64Url(new Uint8Array(32)),
    databaseByteLength: statSync(database).size,
    attachments: [],
    skillRevisions: skillRevisions.map(({ revisionHash, archive }) => ({
      revisionHash,
      byteLength: archive.byteLength,
    })),
  } as const;
  const archivePaths = skillRevisions.map(({ archive }, index) => {
    const path = join(dir, `sent-${String(index)}.tar`);
    writeFileSync(path, archive);
    return path;
  });
  const chunks = await Effect.runPromise(
    Stream.runCollect(streamTransfer(header, database, [], archivePaths)),
  );
  const path = join(dir, "transfer");
  writeFileSync(path, Buffer.concat([...chunks]));
  return path;
};

/**
 * Writes a transfer to a file and returns its path. Its database holds an
 * empty `secrets` table and a `skill_revisions` row per hash of
 * `skillRevisions`, the two tables a receive reads, so the transfer is
 * received whole. It carries each of `skillRevisions` after the database.
 */
const writeTransfer = async (
  schemaVersion: number,
  skillRevisions: ReadonlyArray<SentSkillRevision> = [],
): Promise<string> => {
  const database = join(dir, "database");
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE secrets (id, owner_kind, owner_id, name, nonce, ciphertext)`;
      yield* sql`CREATE TABLE skill_revisions (hash)`;
      for (const { revisionHash } of skillRevisions) {
        yield* sql`INSERT INTO skill_revisions (hash) VALUES (${revisionHash})`;
      }
    }).pipe(Effect.provide(openDatabaseCopy(database))),
  );
  return writeTransferOf(database, schemaVersion, skillRevisions);
};

const buildHomeB = () => buildHomePaths(join(dir, "home"), "data");

/** Returns the bytes of a random promotion token. */
const buildTokenBytes = () => crypto.getRandomValues(new Uint8Array(32));

/** Reserves the Home at `paths`, receives `transferFile` into it, and ends the reservation. */
const receiveIntoHome = (
  paths: HomePaths,
  transferFile: string,
  previewedControllerId: string = CONTROLLER_ID,
) =>
  Effect.scoped(
    Effect.flatMap(reserveHome(paths, "file"), (home) =>
      receiveTransfer(home, buildTokenBytes(), previewedControllerId, transferFile),
    ),
  );

/** Opens the database at `path` the way a controller does, and closes it again. */
const openAsController = (path: string) => Effect.scoped(Layer.build(openDatabase(path)));

/**
 * A `security` CLI that keeps items in memory, for the command shape the
 * macOS store sends. `beforeAdd` runs when an add starts, before the item is
 * stored, the way the real command takes a while before the Keychain holds
 * the item.
 */
const createFakeSecurityRunner =
  (items: Map<string, string>, beforeAdd: () => Promise<void> = () => Promise.resolve()) =>
  async (argv: ReadonlyArray<string>): ReturnType<SecurityRunner> => {
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    const missing = { exitCode: 44, stdout: "", stderr: "" };
    const account = argv[argv.indexOf("-a") + 1] ?? "";
    switch (argv[1]) {
      case "find-generic-password": {
        const value = items.get(account);
        return value === undefined ? missing : { ...ok, stdout: `${value}\n` };
      }
      case "add-generic-password":
        await beforeAdd();
        items.set(account, argv[argv.indexOf("-w") + 1] ?? "");
        return ok;
      case "delete-generic-password":
        return items.delete(account) ? ok : missing;
      default:
        return { exitCode: 1, stdout: "", stderr: "" };
    }
  };

describe("reserveHome", () => {
  it("refuses a Home that already holds a database, and leaves it", async () => {
    const paths = buildHomeB();
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.databaseFile, "keep-me");
    const exit = await Effect.runPromiseExit(Effect.scoped(reserveHome(paths, "file")));
    expect(JSON.stringify(exit)).toContain(`${paths.databaseFile} already exists`);
    expect(readFileSync(paths.databaseFile, "utf8")).toBe("keep-me");
  });

  it("refuses a controller's Home while it sends a transfer, and leaves the transfer's copy", async () => {
    const paths = buildHomeB();
    const outgoing = join(paths.promotionTransferDir, "outgoing-abc");
    mkdirSync(outgoing, { recursive: true });
    writeFileSync(join(outgoing, "database.db"), "copy");
    writeFileSync(paths.databaseFile, "keep-me");
    const exit = await Effect.runPromiseExit(Effect.scoped(reserveHome(paths, "file")));
    expect(JSON.stringify(exit)).toContain(`${paths.databaseFile} already exists`);
    expect(JSON.stringify(exit)).not.toContain("remove");
    expect(readFileSync(paths.databaseFile, "utf8")).toBe("keep-me");
    expect(readdirSync(paths.promotionTransferDir)).toEqual(["outgoing-abc"]);
    expect(readFileSync(join(outgoing, "database.db"), "utf8")).toBe("copy");
  });

  it("refuses a Home that a killed promotion left behind, and leaves what it left", async () => {
    const paths = buildHomeB();
    const incoming = join(paths.promotionTransferDir, "incoming-abc");
    mkdirSync(incoming, { recursive: true });
    writeFileSync(join(incoming, "reservation.db"), "");
    linkSync(join(incoming, "reservation.db"), paths.databaseFile);
    const exit = await Effect.runPromiseExit(Effect.scoped(reserveHome(paths, "file")));
    expect(JSON.stringify(exit)).toContain(`${paths.databaseFile} already exists`);
    expect(readdirSync(paths.promotionTransferDir)).toEqual(["incoming-abc"]);
    expect(existsSync(paths.databaseFile)).toBe(true);
  });

  it("refuses a Home whose store already holds a master key, and leaves the key", async () => {
    const paths = buildHomeB();
    mkdirSync(paths.home, { recursive: true });
    await Effect.runPromise(createMasterKey(openKeyStore(paths, "file")));
    const key = readFileSync(paths.masterKeyFile);
    const exit = await Effect.runPromiseExit(Effect.scoped(reserveHome(paths, "file")));
    expect(JSON.stringify(exit)).toContain("already holds a master key");
    expect(readFileSync(paths.masterKeyFile)).toEqual(key);
    expect(existsSync(paths.dataDir)).toBe(false);
  });

  it("refuses a controller that starts in the Home until the reservation ends", async () => {
    const paths = buildHomeB();
    const transferFile = await writeTransfer(1);
    const refusals = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const home = yield* reserveHome(paths, "file");
          const beforeReceive = yield* Effect.flip(openAsController(paths.databaseFile));
          yield* receiveTransfer(home, buildTokenBytes(), CONTROLLER_ID, transferFile);
          const afterReceive = yield* Effect.flip(openAsController(paths.databaseFile));
          return [beforeReceive.message, afterReceive.message];
        }),
      ),
    );
    for (const refusal of refusals) expect(refusal).toContain("is already open");
    expect(readdirSync(paths.dataDir).sort()).toEqual(["attachments", "hercule.db", "skills"]);

    await Effect.runPromise(openAsController(paths.databaseFile));
  });
});

describe("receiveTransfer", () => {
  it("leaves only the database and the attachments directory in the data directory", async () => {
    const paths = buildHomeB();
    await Effect.runPromise(receiveIntoHome(paths, await writeTransfer(1)));
    expect(existsSync(paths.promotionTransferDir)).toBe(false);
    expect(existsSync(`${paths.databaseFile}-wal`)).toBe(false);
    expect(existsSync(paths.masterKeyFile)).toBe(true);
  });

  it("refuses a transfer from another controller than the preview showed, and leaves the Home empty", async () => {
    const paths = buildHomeB();
    const previewed = "0198e4b0-0000-7000-8000-000000000002";
    const exit = await Effect.runPromiseExit(
      receiveIntoHome(paths, await writeTransfer(1), previewed),
    );
    expect(JSON.stringify(exit)).toContain(
      `The transfer came from controller ${CONTROLLER_ID}, but the preview showed controller ${previewed}`,
    );
    expect(existsSync(paths.home)).toBe(false);
  });

  it("refuses a Skill Revision archive whose files changed on the way, and leaves the Home empty", async () => {
    const files: ReadonlyArray<SkillFile> = [
      {
        path: "SKILL.md",
        mode: "644",
        content: new TextEncoder().encode("---\nname: teach\ndescription: Teaches.\n---\n"),
      },
    ];
    const revisionHash = await Effect.runPromise(computeSkillRevisionHash(files));
    const archive = await Effect.runPromise(buildSkillArchive(files));
    // The first file's content starts after its 512-byte header.
    const tampered = new Uint8Array(archive);
    tampered[512] = "X".charCodeAt(0);
    const paths = buildHomeB();
    const exit = await Effect.runPromiseExit(
      receiveIntoHome(paths, await writeTransfer(1, [{ revisionHash, archive: tampered }])),
    );
    expect(JSON.stringify(exit)).toContain(
      `the files of Skill Revision ${revisionHash} arrived with the hash`,
    );
    expect(existsSync(paths.home)).toBe(false);
  });

  it("refuses a Skill Revision file whose path leaves the skill's folder, even when the hash matches", async () => {
    const files: ReadonlyArray<SkillFile> = [
      { path: "../../escaped", mode: "644", content: new TextEncoder().encode("outside") },
    ];
    const revisionHash = await Effect.runPromise(computeSkillRevisionHash(files));
    const archive = await Effect.runPromise(buildSkillArchive(files));
    const paths = buildHomeB();
    const exit = await Effect.runPromiseExit(
      receiveIntoHome(paths, await writeTransfer(1, [{ revisionHash, archive }])),
    );
    expect(JSON.stringify(exit)).toContain("Paths must stay inside the skill's folder");
    expect(existsSync(paths.home)).toBe(false);
    expect(existsSync(join(dir, "escaped"))).toBe(false);
  });

  it("refuses a Skill Revision whose paths differ only in case, even when the hash matches", async () => {
    const files: ReadonlyArray<SkillFile> = [
      { path: "A.md", mode: "644", content: new TextEncoder().encode("upper") },
      { path: "a.md", mode: "644", content: new TextEncoder().encode("lower") },
    ];
    const revisionHash = await Effect.runPromise(computeSkillRevisionHash(files));
    const archive = await Effect.runPromise(buildSkillArchive(files));
    const paths = buildHomeB();
    const exit = await Effect.runPromiseExit(
      receiveIntoHome(paths, await writeTransfer(1, [{ revisionHash, archive }])),
    );
    expect(JSON.stringify(exit)).toContain("differ only in case");
    expect(existsSync(paths.home)).toBe(false);
  });

  it("refuses a Skill Revision archive larger than a skill may be, before reading it", async () => {
    const revisionHash = "c".repeat(64);
    const archive = new Uint8Array(MAX_SKILL_BYTES + 512);
    const paths = buildHomeB();
    const exit = await Effect.runPromiseExit(
      receiveIntoHome(paths, await writeTransfer(1, [{ revisionHash, archive }])),
    );
    expect(JSON.stringify(exit)).toContain(
      `the archive of Skill Revision ${revisionHash} is ${String(MAX_SKILL_BYTES + 512)} bytes`,
    );
    expect(existsSync(paths.home)).toBe(false);
  });

  it("refuses a Skill Revision archive that is not the one its files build, even when the hash matches", async () => {
    const files: ReadonlyArray<SkillFile> = [
      { path: "SKILL.md", mode: "644", content: new TextEncoder().encode("Body\n") },
    ];
    const revisionHash = await Effect.runPromise(computeSkillRevisionHash(files));
    const archive = await Effect.runPromise(buildSkillArchive(files));
    // The archive still reads without its two 512-byte end blocks.
    const shortened = archive.subarray(0, archive.byteLength - 1024);
    const paths = buildHomeB();
    const exit = await Effect.runPromiseExit(
      receiveIntoHome(paths, await writeTransfer(1, [{ revisionHash, archive: shortened }])),
    );
    expect(JSON.stringify(exit)).toContain(
      `the archive of Skill Revision ${revisionHash} is not the archive the old controller builds`,
    );
    expect(existsSync(paths.home)).toBe(false);
  });

  it("refuses a schema newer than this build, and leaves the Home empty", async () => {
    const paths = buildHomeB();
    const exit = await Effect.runPromiseExit(receiveIntoHome(paths, await writeTransfer(99_999)));
    expect(JSON.stringify(exit)).toContain("too old");
    expect(existsSync(paths.home)).toBe(false);
  });

  it("removes the master key when interrupted while creating it, so a retry succeeds", async () => {
    const paths = buildHomeB();
    const transferFile = await writeTransfer(1);
    const items = new Map<string, string>();
    let addStarted!: () => void;
    const started = new Promise<void>((resolve) => (addStarted = resolve));
    let finishAdd!: () => void;
    const finished = new Promise<void>((resolve) => (finishAdd = resolve));
    // The interrupt arrives while `security` is still storing the key, and
    // the key lands in the Keychain only after that.
    const slowAdd = createFakeSecurityRunner(items, () => {
      addStarted();
      return finished;
    });

    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.flatMap(reserveHome(paths, "keychain", slowAdd), (home) =>
          receiveTransfer(home, buildTokenBytes(), CONTROLLER_ID, transferFile),
        ),
      ),
    );
    await started;
    // The interrupt is sent synchronously, so it has reached the fiber
    // before the add is allowed to finish.
    fiber.interruptUnsafe();
    finishAdd();
    await Effect.runPromise(Fiber.await(fiber));
    expect(items.size).toBe(0);
    expect(existsSync(paths.home)).toBe(false);

    await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(reserveHome(paths, "keychain", createFakeSecurityRunner(items)), (home) =>
          receiveTransfer(home, buildTokenBytes(), CONTROLLER_ID, transferFile),
        ),
      ),
    );
    expect(items.size).toBe(1);
    expect(existsSync(paths.databaseFile)).toBe(true);
  });
});

describe("receiveTransfer, from a database with Skill Revisions", () => {
  const USER: Actor = {
    _tag: "user",
    userId: "0199f0b7-0000-7000-8000-000000000000",
    credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash: "x" },
  };

  const encode = (text: string) => new TextEncoder().encode(text);

  /** Returns the files of a valid skill named `name`. */
  const buildFiles = (name: string): ReadonlyArray<SkillFile> => [
    {
      path: "SKILL.md",
      mode: "644",
      content: encode(`---\nname: ${name}\ndescription: Teaches.\n---\nBody\n`),
    },
  ];

  /**
   * Imports the skill `teach` into a migrated database in a Home of its own,
   * the way the old controller stores it, and returns that database, the
   * revision's hash, and the archive the controller stored for it.
   */
  const importIntoOldHome = async () => {
    const paths = buildHomePaths(join(dir, "old-home"), join(dir, "old-home", "data"));
    mkdirSync(paths.dataDir, { recursive: true });
    const stack = SkillServiceLayer.pipe(
      Layer.provideMerge(AuditLogLayer),
      Layer.provideMerge(openDatabase(paths.databaseFile)),
      Layer.provideMerge(Layer.succeed(HerculeHome, paths)),
    );
    const imported = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations();
        const service = yield* SkillService;
        return yield* service.import(
          { name: "teach" },
          yield* buildSkillArchive(buildFiles("teach")),
        );
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(stack)),
    );
    const revisionHash = imported.skill.currentRevisionHash ?? "";
    const archive = new Uint8Array(
      readFileSync(buildSkillArchivePath(paths.dataDir, revisionHash)),
    );
    return { database: paths.databaseFile, revisionHash, archive };
  };

  /** Receives a transfer of `database` that carries `skillRevisions` into a new Home. */
  const receiveRevisions = async (
    database: string,
    skillRevisions: ReadonlyArray<SentSkillRevision>,
  ) => {
    const paths = buildHomeB();
    const transferFile = await writeTransferOf(database, binaryVersion, skillRevisions);
    const exit = await Effect.runPromiseExit(receiveIntoHome(paths, transferFile));
    return { paths, exit };
  };

  it("writes each revision's archive, as sent, to its own file in the Data Root", async () => {
    const sent = await importIntoOldHome();
    const { paths, exit } = await receiveRevisions(sent.database, [sent]);
    expect(exit._tag).toBe("Success");
    expect(
      new Uint8Array(readFileSync(buildSkillArchivePath(paths.dataDir, sent.revisionHash))),
    ).toEqual(sent.archive);
  });

  it("refuses a transfer that lacks the archive of a revision in its database, and leaves the Home empty", async () => {
    const sent = await importIntoOldHome();
    const { paths, exit } = await receiveRevisions(sent.database, []);
    expect(JSON.stringify(exit)).toContain(
      `the promotion transfer does not carry one archive per Skill Revision in its database: ` +
        `it lacks the archive of ${sent.revisionHash}`,
    );
    expect(existsSync(paths.home)).toBe(false);
  });

  it("refuses a transfer that carries a revision's archive twice", async () => {
    const sent = await importIntoOldHome();
    const { paths, exit } = await receiveRevisions(sent.database, [sent, sent]);
    expect(JSON.stringify(exit)).toContain(
      `it carries the archive of ${sent.revisionHash} more than once`,
    );
    expect(existsSync(paths.home)).toBe(false);
  });

  it("refuses a transfer whose archive was swapped for one no revision names", async () => {
    const sent = await importIntoOldHome();
    const other = buildFiles("other");
    const swapped = {
      revisionHash: await Effect.runPromise(computeSkillRevisionHash(other)),
      archive: await Effect.runPromise(buildSkillArchive(other)),
    };
    const { paths, exit } = await receiveRevisions(sent.database, [swapped]);
    const message = JSON.stringify(exit);
    expect(message).toContain(`it lacks the archive of ${sent.revisionHash}`);
    expect(message).toContain(
      `it carries archives no Skill Revision names: ${swapped.revisionHash}`,
    );
    expect(existsSync(paths.home)).toBe(false);
  });
});
