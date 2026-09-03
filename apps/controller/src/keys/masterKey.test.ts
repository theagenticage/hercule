import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { homePaths, HydraHome } from "../config";
import { TestDatabase } from "../db/testing";
import {
  KEYCHAIN_SERVICE,
  keychainStore,
  MASTER_KEY_BYTES,
  MasterKey,
  masterKeyLayer,
  type SecurityRunner,
} from "./masterKey";

let home: string;

const keyFile = () => join(home, "master.key");

const homeLayer = (): Layer.Layer<HydraHome> =>
  Layer.succeed(HydraHome, HydraHome.of(homePaths(home, join(home, "data"))));

/** Never the keychain backend: a test must not write to the developer's login keychain. */
const build = () =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const { key } = yield* MasterKey;
      return key;
    }).pipe(
      Effect.provide(masterKeyLayer("file")),
      Effect.provide(homeLayer()),
      Effect.provide(TestDatabase),
    ),
  );

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-keys-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the master key file", () => {
  it("mints a 32-byte key at mode 0600 on first run", async () => {
    const exit = await build();
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(statSync(keyFile()).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(keyFile(), "utf8").trim(), "base64")).toHaveLength(
      MASTER_KEY_BYTES,
    );
  });

  it("reads the same key back on the next layer build", async () => {
    await build();
    const first = readFileSync(keyFile(), "utf8");
    await build();
    expect(readFileSync(keyFile(), "utf8")).toBe(first);
  });

  it("provides a non-extractable AES-GCM key", async () => {
    const exit = await build();
    const key = Exit.isSuccess(exit) ? exit.value : undefined;
    expect(key?.algorithm.name).toBe("AES-GCM");
    expect(key?.extractable).toBe(false);
    expect(key?.usages.sort()).toEqual(["decrypt", "encrypt"]);
  });

  it("refuses a file that does not hold 32 bytes", async () => {
    writeFileSync(keyFile(), Buffer.from("short").toString("base64"), { mode: 0o600 });
    const exit = await build();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("32 bytes");
  });

  it("refuses a key file anyone but its owner can read", async () => {
    await build();
    chmodSync(keyFile(), 0o644);
    const exit = await build();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("0644");
  });

  it("never puts the key in an error", async () => {
    // A missing home: the write fails, and the message must name the path and
    // nothing else.
    rmSync(home, { recursive: true, force: true });
    const exit = await build();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("Cannot write the master key");
  });
});

describe("the keychain store", () => {
  /** A `security` that records what it was asked and answers what the test says. */
  const runner = (answers: ReadonlyArray<{ exitCode: number; stdout: string }>) => {
    const calls: Array<ReadonlyArray<string>> = [];
    let next = 0;
    const run: SecurityRunner = (argv) => {
      calls.push(argv);
      return Promise.resolve(answers[next++]!);
    };
    return { run, calls };
  };

  const key = new Uint8Array(MASTER_KEY_BYTES).fill(7);

  it("scopes the item to this home, and answers the stored key", async () => {
    const { run, calls } = runner([
      { exitCode: 0, stdout: `${Buffer.from(key).toString("base64")}\n` },
    ]);
    const found = await Effect.runPromise(keychainStore("/Users/x/.hydra", run).read);
    expect(found).toEqual(key);
    expect(calls[0]).toEqual([
      "security",
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      "/Users/x/.hydra",
      "-w",
    ]);
  });

  it("reads no key when the item is not in the keychain", async () => {
    const { run } = runner([{ exitCode: 44, stdout: "" }]);
    expect(await Effect.runPromise(keychainStore("/Users/x/.hydra", run).read)).toBeUndefined();
  });

  it("fails, naming the exit code, when security says anything else", async () => {
    const { run } = runner([{ exitCode: 1, stdout: "" }]);
    const exit = await Effect.runPromiseExit(keychainStore("/Users/x/.hydra", run).read);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("exited 1");
  });

  it("fails when the item does not hold 32 bytes", async () => {
    const { run } = runner([{ exitCode: 0, stdout: "bm90LWEta2V5\n" }]);
    const exit = await Effect.runPromiseExit(keychainStore("/Users/x/.hydra", run).read);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("32 bytes");
  });

  it("updates an existing item rather than adding a duplicate", async () => {
    const { run, calls } = runner([{ exitCode: 0, stdout: "" }]);
    await Effect.runPromise(keychainStore("/Users/x/.hydra", run).write(key));
    expect(calls[0]).toEqual([
      "security",
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      "/Users/x/.hydra",
      "-w",
      Buffer.from(key).toString("base64"),
      "-U",
    ]);
  });

  it("fails when security cannot store the item", async () => {
    const { run } = runner([{ exitCode: 45, stdout: "" }]);
    const exit = await Effect.runPromiseExit(keychainStore("/Users/x/.hydra", run).write(key));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("exited 45");
    expect(String(exit)).not.toContain(Buffer.from(key).toString("base64"));
  });
});
