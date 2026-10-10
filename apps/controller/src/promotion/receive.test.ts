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
import { openDatabase, openDatabaseCopy } from "../db";
import { createMasterKey, openKeyStore, type SecurityRunner } from "../secrets";
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

/**
 * Writes a transfer to a file and returns its path. Its database holds an
 * empty `secrets` table, the one table a receive reads, so the transfer is
 * received whole.
 */
const writeTransfer = async (schemaVersion: number): Promise<string> => {
  const database = join(dir, "database");
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE secrets (id, owner_kind, owner_id, name, nonce, ciphertext)`;
    }).pipe(Effect.provide(openDatabaseCopy(database))),
  );
  const header = {
    formatVersion: TRANSFER_FORMAT_VERSION,
    controllerId: CONTROLLER_ID,
    schemaVersion,
    salt: encodeBase64Url(new Uint8Array(32)),
    databaseByteLength: statSync(database).size,
    attachments: [],
  } as const;
  const chunks = await Effect.runPromise(Stream.runCollect(streamTransfer(header, database, [])));
  const path = join(dir, "transfer");
  writeFileSync(path, Buffer.concat([...chunks]));
  return path;
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
    expect(readdirSync(paths.dataDir).sort()).toEqual(["attachments", "hercule.db"]);

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
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await new Promise((resolve) => setTimeout(resolve, 50));
    finishAdd();
    await interrupted;
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
