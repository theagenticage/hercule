import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { buildHomePaths, HerculeHome } from "../config";
import { TestDatabase } from "../db/testing";
import {
  createFileStore,
  KEYCHAIN_SERVICE,
  createKeychainStore,
  MASTER_KEY_BYTES,
  MasterKey,
  masterKeyLayer,
  type SecurityRunner,
} from "./masterKey";

let home: string;

const buildKeyFilePath = () => join(home, "master.key");

const buildHomeLayer = (): Layer.Layer<HerculeHome> =>
  Layer.succeed(HerculeHome, HerculeHome.of(buildHomePaths(home, join(home, "data"))));

/** Builds the master key with the file backend: a test must not touch the developer's keychain. */
const buildMasterKey = () =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const { key } = yield* MasterKey;
      return key;
    }).pipe(
      Effect.provide(masterKeyLayer("file")),
      Effect.provide(buildHomeLayer()),
      Effect.provide(TestDatabase),
    ),
  );

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-keys-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the master key file", () => {
  it("mints a 32-byte key at mode 0600 on first run", async () => {
    const exit = await buildMasterKey();
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(statSync(buildKeyFilePath()).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(buildKeyFilePath(), "utf8").trim(), "base64")).toHaveLength(
      MASTER_KEY_BYTES,
    );
  });

  it("keeps the key another process created between the read and the write", async () => {
    // The race a second `hercule serve` on an empty home loses: it found no file,
    // minted, and by the time it wrote, the first boot's key was already there.
    const winner = new Uint8Array(MASTER_KEY_BYTES).fill(3);
    writeFileSync(buildKeyFilePath(), `${Buffer.from(winner).toString("base64")}\n`, {
      mode: 0o600,
    });
    const loser = new Uint8Array(MASTER_KEY_BYTES).fill(4);
    expect(await Effect.runPromise(createFileStore(buildKeyFilePath()).write(loser))).toEqual(
      winner,
    );
    expect(readFileSync(buildKeyFilePath(), "utf8").trim()).toBe(
      Buffer.from(winner).toString("base64"),
    );
  });

  it("reads the same key back on the next layer build", async () => {
    await buildMasterKey();
    const first = readFileSync(buildKeyFilePath(), "utf8");
    await buildMasterKey();
    expect(readFileSync(buildKeyFilePath(), "utf8")).toBe(first);
  });

  it("provides a non-extractable AES-GCM key", async () => {
    const exit = await buildMasterKey();
    const key = Exit.isSuccess(exit) ? exit.value : undefined;
    expect(key?.algorithm.name).toBe("AES-GCM");
    expect(key?.extractable).toBe(false);
    expect(key?.usages.sort()).toEqual(["decrypt", "encrypt"]);
  });

  it("rejects a file that does not hold 32 bytes", async () => {
    writeFileSync(buildKeyFilePath(), Buffer.from("short").toString("base64"), { mode: 0o600 });
    const exit = await buildMasterKey();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("32 bytes");
  });

  it("rejects a key file that anyone but its owner can read", async () => {
    await buildMasterKey();
    chmodSync(buildKeyFilePath(), 0o644);
    const exit = await buildMasterKey();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("0644");
  });

  it("never puts the key in an error", async () => {
    // A missing home: the write fails, and the message must name the path and
    // nothing else.
    rmSync(home, { recursive: true, force: true });
    const exit = await buildMasterKey();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("Cannot write the master key");
  });
});

describe("the keychain store", () => {
  /**
   * Creates a fake `security` that records each call and returns the results
   * the test gives it. A result with no `stderr` printed nothing there.
   */
  const createFakeSecurityRunner = (
    answers: ReadonlyArray<{ exitCode: number; stdout: string; stderr?: string }>,
  ) => {
    const calls: Array<ReadonlyArray<string>> = [];
    let next = 0;
    const run: SecurityRunner = (argv) => {
      calls.push(argv);
      const answer = answers[next++]!;
      return Promise.resolve({ stderr: "", ...answer });
    };
    return { run, calls };
  };

  const key = new Uint8Array(MASTER_KEY_BYTES).fill(7);

  it("scopes the item to this home, and returns the stored key", async () => {
    const { run, calls } = createFakeSecurityRunner([
      { exitCode: 0, stdout: `${Buffer.from(key).toString("base64")}\n` },
    ]);
    const found = await Effect.runPromise(createKeychainStore("/Users/x/.hercule", run).read);
    expect(found).toEqual(key);
    expect(calls[0]).toEqual([
      "security",
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      "/Users/x/.hercule",
      "-w",
    ]);
  });

  it("reads no key when the item is not in the keychain", async () => {
    const { run } = createFakeSecurityRunner([{ exitCode: 44, stdout: "" }]);
    expect(
      await Effect.runPromise(createKeychainStore("/Users/x/.hercule", run).read),
    ).toBeUndefined();
  });

  it("fails, with the exit code in the message, when security exits with any other code", async () => {
    const { run } = createFakeSecurityRunner([{ exitCode: 1, stdout: "" }]);
    const exit = await Effect.runPromiseExit(createKeychainStore("/Users/x/.hercule", run).read);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("exited 1");
  });

  it("puts what security printed on stderr into the failure, on one line", async () => {
    const { run } = createFakeSecurityRunner([
      {
        exitCode: 36,
        stdout: "",
        stderr:
          "security: SecKeychainSearchCopyNext: User interaction is not allowed.\n" +
          "  (the keychain is locked)\n",
      },
    ]);
    const exit = await Effect.runPromiseExit(createKeychainStore("/Users/x/.hercule", run).read);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain(
      `exited 36 for the ${KEYCHAIN_SERVICE} keychain item for account /Users/x/.hercule. It printed: ` +
        "security: SecKeychainSearchCopyNext: User interaction is not allowed. " +
        "(the keychain is locked)",
    );
  });

  it("fails when the item does not hold 32 bytes", async () => {
    const { run } = createFakeSecurityRunner([{ exitCode: 0, stdout: "bm90LWEta2V5\n" }]);
    const exit = await Effect.runPromiseExit(createKeychainStore("/Users/x/.hercule", run).read);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("32 bytes");
  });

  it("adds the item without -U, so an existing one is never overwritten", async () => {
    const { run, calls } = createFakeSecurityRunner([{ exitCode: 0, stdout: "" }]);
    expect(
      await Effect.runPromise(createKeychainStore("/Users/x/.hercule", run).write(key)),
    ).toEqual(key);
    expect(calls[0]).toEqual([
      "security",
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      "/Users/x/.hercule",
      "-w",
      Buffer.from(key).toString("base64"),
    ]);
  });

  it("returns the key another boot stored when the add fails", async () => {
    const stored = new Uint8Array(MASTER_KEY_BYTES).fill(9);
    // 45: the item is already there, because another first boot won the race.
    const { run, calls } = createFakeSecurityRunner([
      { exitCode: 45, stdout: "" },
      { exitCode: 0, stdout: `${Buffer.from(stored).toString("base64")}\n` },
    ]);
    expect(
      await Effect.runPromise(createKeychainStore("/Users/x/.hercule", run).write(key)),
    ).toEqual(stored);
    expect(calls[1]?.[1]).toBe("find-generic-password");
  });

  it("fails when security cannot store the item and there is none to read", async () => {
    const { run } = createFakeSecurityRunner([
      { exitCode: 45, stdout: "", stderr: "security: The specified item already exists.\n" },
      { exitCode: 44, stdout: "" },
    ]);
    const exit = await Effect.runPromiseExit(
      createKeychainStore("/Users/x/.hercule", run).write(key),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("exited 45");
    expect(String(exit)).toContain("It printed: security: The specified item already exists.");
    expect(String(exit)).not.toContain(Buffer.from(key).toString("base64"));
  });
});
