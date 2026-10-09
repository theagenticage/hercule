import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { buildHomePaths } from "@hercule/home";
import { createMasterKey, openKeyStore } from "../secrets";
import { streamTransfer, TRANSFER_FORMAT_VERSION } from "./bundle";
import { encodeBase64Url } from "./crypto";
import { receiveTransfer } from "./receive";

/** The controller every transfer in this file comes from, and the one its preview showed. */
const CONTROLLER_ID = "0198e4b0-0000-7000-8000-000000000001";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hercule-promote-b-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a transfer of an empty database at `schemaVersion` to a file, and returns its path. */
const writeEmptyTransfer = async (schemaVersion: number): Promise<string> => {
  const database = join(dir, "database");
  writeFileSync(database, new Uint8Array());
  const header = {
    formatVersion: TRANSFER_FORMAT_VERSION,
    controllerId: CONTROLLER_ID,
    schemaVersion,
    salt: encodeBase64Url(new Uint8Array(32)),
    databaseByteLength: 0,
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

describe("receiveTransfer", () => {
  it("refuses a Home that already holds a database, and writes nothing", async () => {
    const paths = buildHomeB();
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(paths.databaseFile, "keep-me");
    const exit = await Effect.runPromiseExit(
      receiveTransfer(paths, buildTokenBytes(), CONTROLLER_ID, await writeEmptyTransfer(1), "file"),
    );
    expect(JSON.stringify(exit)).toContain("already exists");
    expect(readFileSync(paths.databaseFile, "utf8")).toBe("keep-me");
  });

  it("refuses a Home whose store already holds a master key, and leaves the key", async () => {
    const paths = buildHomeB();
    mkdirSync(paths.home, { recursive: true });
    await Effect.runPromise(createMasterKey(openKeyStore(paths, "file")));
    const key = readFileSync(paths.masterKeyFile);
    const exit = await Effect.runPromiseExit(
      receiveTransfer(paths, buildTokenBytes(), CONTROLLER_ID, await writeEmptyTransfer(1), "file"),
    );
    expect(JSON.stringify(exit)).toContain("already holds a master key");
    expect(readFileSync(paths.masterKeyFile)).toEqual(key);
    expect(existsSync(paths.databaseFile)).toBe(false);
  });

  it("refuses a transfer from another controller than the preview showed, and writes nothing", async () => {
    const paths = buildHomeB();
    const previewed = "0198e4b0-0000-7000-8000-000000000002";
    const exit = await Effect.runPromiseExit(
      receiveTransfer(paths, buildTokenBytes(), previewed, await writeEmptyTransfer(1), "file"),
    );
    expect(JSON.stringify(exit)).toContain(
      `The transfer came from controller ${CONTROLLER_ID}, but the preview showed controller ${previewed}`,
    );
    expect(existsSync(paths.dataDir)).toBe(false);
    expect(existsSync(paths.masterKeyFile)).toBe(false);
  });

  it("refuses a schema newer than this build, and writes nothing", async () => {
    const paths = buildHomeB();
    const exit = await Effect.runPromiseExit(
      receiveTransfer(
        paths,
        buildTokenBytes(),
        CONTROLLER_ID,
        await writeEmptyTransfer(99_999),
        "file",
      ),
    );
    expect(JSON.stringify(exit)).toContain("too old");
    expect(existsSync(paths.dataDir)).toBe(false);
    expect(existsSync(paths.masterKeyFile)).toBe(false);
  });
});
