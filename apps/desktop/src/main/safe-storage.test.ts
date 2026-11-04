import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { DesktopPlatform } from "../ipc/platform/desktop-platform";
import { makeSafeStorageLayer, SafeStorage, type ElectronSafeStorageCalls } from "./safe-storage";

/** What Electron's `safeStorage` reports on Linux, and what the fake records. */
interface FakeElectronOptions {
  readonly backend: ReturnType<ElectronSafeStorageCalls["getSelectedStorageBackend"]>;
  readonly available: boolean;
}

/**
 * Returns a fake of Electron's `safeStorage` and the calls made on it. It
 * "encrypts" by prefixing the text with `sealed:`, and, like Electron before
 * version 44, reports `basic_text` as available when `available` says so.
 * Every call it gets is recorded by name; `getSelectedStorageBackend` and
 * `isEncryptionAvailable` exist on Linux only, so on macOS the test fails
 * when either is called.
 */
const makeFakeElectron = (
  platform: DesktopPlatform,
  { backend, available }: FakeElectronOptions,
) => {
  const calls: Array<string> = [];
  const linuxOnly = <A>(name: string, value: A): A => {
    if (platform !== "linux") throw new Error(`${name} does not exist on ${platform}`);
    calls.push(name);
    return value;
  };
  const electron: ElectronSafeStorageCalls = {
    isEncryptionAvailable: () => linuxOnly("isEncryptionAvailable", available),
    getSelectedStorageBackend: () => linuxOnly("getSelectedStorageBackend", backend),
    setUsePlainTextEncryption: (usePlainText) => {
      calls.push(`setUsePlainTextEncryption(${String(usePlainText)})`);
    },
    encryptString: (text) => {
      calls.push("encryptString");
      return Buffer.from(`sealed:${text}`);
    },
    decryptString: (encrypted) => {
      calls.push("decryptString");
      return encrypted.toString().slice("sealed:".length);
    },
  };
  return { electron, calls };
};

/** Encrypts "secret" and decrypts the result, with the layer built on `electron`. */
const roundTrip = (
  electron: ElectronSafeStorageCalls,
  platform: DesktopPlatform,
  fixedKeyForTests: boolean,
) =>
  Effect.runPromiseExit(
    SafeStorage.use((safeStorage) =>
      safeStorage.encrypt("secret").pipe(Effect.flatMap(safeStorage.decrypt)),
    ).pipe(Effect.provide(makeSafeStorageLayer(electron, platform, fixedKeyForTests))),
  );

describe("the SafeStorage layer on Linux", () => {
  it.each(["basic_text", "unknown"] as const)(
    "never encrypts under the %s backend, even when Electron reports it as available",
    async (backend) => {
      const { electron, calls } = makeFakeElectron("linux", { backend, available: true });
      const exit = await roundTrip(electron, "linux", false);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("no keyring");
      // `isEncryptionAvailable` comes first: it is what selects the backend.
      expect(calls).toEqual(["isEncryptionAvailable", "getSelectedStorageBackend"]);
    },
  );

  it("fails when the keyring backend is selected but Electron cannot reach the keyring", async () => {
    const { electron, calls } = makeFakeElectron("linux", {
      backend: "gnome_libsecret",
      available: false,
    });
    const exit = await roundTrip(electron, "linux", false);
    expect(String(exit)).toContain("keyring is not available");
    expect(calls).not.toContain("encryptString");
  });

  it.each(["gnome_libsecret", "kwallet5", "kwallet6"] as const)(
    "encrypts with the %s backend when it is available",
    async (backend) => {
      const { electron, calls } = makeFakeElectron("linux", { backend, available: true });
      expect(await roundTrip(electron, "linux", false)).toEqual(Exit.succeed("secret"));
      expect(calls).not.toContain("setUsePlainTextEncryption(true)");
    },
  );

  it("encrypts with the fixed key when a test asked for the mock keychain", async () => {
    const { electron, calls } = makeFakeElectron("linux", {
      backend: "basic_text",
      available: false,
    });
    expect(await roundTrip(electron, "linux", true)).toEqual(Exit.succeed("secret"));
    expect(calls[0]).toBe("setUsePlainTextEncryption(true)");
  });
});

describe("the SafeStorage layer on macOS", () => {
  it("calls only encrypt and decrypt, and ignores a request for the fixed key", async () => {
    const { electron, calls } = makeFakeElectron("mac", { backend: "basic_text", available: true });
    expect(await roundTrip(electron, "mac", true)).toEqual(Exit.succeed("secret"));
    expect(calls).toEqual(["encryptString", "decryptString"]);
  });
});

describe("the SafeStorage layer's key store name", () => {
  it.each([
    ["mac", "Keychain"],
    ["linux", "keyring"],
  ] as const)("is the %s platform's: %s", async (platform, name) => {
    const { electron } = makeFakeElectron(platform, { backend: "basic_text", available: false });
    const keyStoreName = await Effect.runPromise(
      SafeStorage.use((safeStorage) => Effect.succeed(safeStorage.keyStoreName)).pipe(
        Effect.provide(makeSafeStorageLayer(electron, platform, false)),
      ),
    );
    expect(keyStoreName).toBe(name);
  });
});
