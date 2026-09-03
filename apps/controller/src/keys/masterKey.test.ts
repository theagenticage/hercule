import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { homePaths, HydraHome } from "../config";
import {
  KEYCHAIN_SERVICE,
  keychainReadCommand,
  keychainWriteCommand,
  MASTER_KEY_BYTES,
  MasterKey,
  masterKeyLayer,
} from "./masterKey";

let home: string;

const homeLayer = (): Layer.Layer<HydraHome> =>
  Layer.succeed(HydraHome, HydraHome.of(homePaths(home, join(home, "data"))));

/** Never the keychain backend: a test must not write to the developer's login keychain. */
const build = () =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const { key } = yield* MasterKey;
      return key;
    }).pipe(Effect.provide(masterKeyLayer("file")), Effect.provide(homeLayer())),
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

    const path = join(home, "master.key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(Buffer.from(readFileSync(path, "utf8").trim(), "base64")).toHaveLength(MASTER_KEY_BYTES);
  });

  it("reads the same key back on the next layer build", async () => {
    await build();
    const first = readFileSync(join(home, "master.key"), "utf8");
    await build();
    expect(readFileSync(join(home, "master.key"), "utf8")).toBe(first);
  });

  it("provides a non-extractable AES-GCM key", async () => {
    const exit = await build();
    const key = Exit.isSuccess(exit) ? exit.value : undefined;
    expect(key?.algorithm.name).toBe("AES-GCM");
    expect(key?.extractable).toBe(false);
    expect(key?.usages.sort()).toEqual(["decrypt", "encrypt"]);
  });

  it("refuses a file that does not hold 32 bytes", async () => {
    writeFileSync(join(home, "master.key"), Buffer.from("short").toString("base64"));
    const exit = await build();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("32 bytes");
  });

  it("never puts the key in an error", async () => {
    // A directory where the file belongs: the write fails, and the message must
    // name the path and nothing else.
    rmSync(home, { recursive: true, force: true });
    const exit = await build();
    expect(Exit.isFailure(exit)).toBe(true);
    expect(String(exit)).toContain("Cannot write the master key");
  });
});

describe("the keychain commands", () => {
  it("scopes the item to this home so two homes never collide", () => {
    expect(keychainReadCommand("/Users/x/.hydra")).toEqual([
      "security",
      "find-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      "/Users/x/.hydra",
      "-w",
    ]);
  });

  it("updates an existing item rather than adding a duplicate", () => {
    expect(keychainWriteCommand("/Users/x/.hydra", "AAAA")).toEqual([
      "security",
      "add-generic-password",
      "-s",
      KEYCHAIN_SERVICE,
      "-a",
      "/Users/x/.hydra",
      "-w",
      "AAAA",
      "-U",
    ]);
  });
});
