import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { makeAppSettingsLayer, NoControllerSaved } from "./app-settings";
import { MainWindow } from "./main-window";
import { MainMenu } from "./menu";
import { KeychainError, SafeStorage } from "./safe-storage";
import { StoredToken, StoredTokenLayer } from "./stored-token";

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hercule-desktop-token-"));
  file = join(folder, "settings.json");
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/**
 * A fake Keychain: it "encrypts" by prefixing the text with `sealed:`, and
 * decrypts only what carries that prefix. `failing` makes both fail, as when
 * the Keychain denies access to its key.
 */
const makeFakeSafeStorage = (failing: boolean): Layer.Layer<SafeStorage> =>
  Layer.succeed(SafeStorage)({
    encrypt: (text) =>
      failing
        ? Effect.fail(new KeychainError({ message: "access denied" }))
        : Effect.succeed(new TextEncoder().encode(`sealed:${text}`)),
    decrypt: (encrypted) => {
      const text = new TextDecoder().decode(encrypted);
      return failing || !text.startsWith("sealed:")
        ? Effect.fail(new KeychainError({ message: "wrong key" }))
        : Effect.succeed(text.slice("sealed:".length));
    },
  });

/** What the fakes of the menu and the window saw. */
interface Seen {
  /** Each state Sign Out was set to, in order. */
  readonly signOutEnabled: Array<boolean>;
  /** Each warning the window showed, in order. */
  readonly warnings: Array<string>;
}

/** Builds fakes of the menu and the window that record what they are asked into `seen`. */
const makeFakeMenuAndWindow = (seen: Seen): Layer.Layer<MainMenu | MainWindow> =>
  Layer.mergeAll(
    Layer.succeed(MainMenu)({
      setSignOutEnabled: (enabled) =>
        Effect.sync(() => {
          seen.signOutEnabled.push(enabled);
        }),
    }),
    Layer.succeed(MainWindow)({
      load: Effect.void,
      reload: Effect.void,
      show: Effect.void,
      showFirstTime: Effect.void,
      send: () => Effect.void,
      showWarning: (message) =>
        Effect.sync(() => {
          seen.warnings.push(message);
        }),
    }),
  );

/**
 * Runs `effect` against a token service built on the settings file `file`,
 * with a fake Keychain that fails when `keychainFailing` is true. Returns the
 * effect's exit and what the menu and the window saw.
 */
const runWithStoredToken = async <A, E>(
  effect: Effect.Effect<A, E, StoredToken>,
  keychainFailing = false,
): Promise<{ exit: Exit.Exit<A, E> } & Seen> => {
  const seen: Seen = { signOutEnabled: [], warnings: [] };
  const layer = StoredTokenLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        makeAppSettingsLayer(file).pipe(Layer.provide(NodeFileSystem.layer)),
        makeFakeSafeStorage(keychainFailing),
        makeFakeMenuAndWindow(seen),
      ),
    ),
  );
  const exit = await Effect.runPromiseExit(Effect.provide(effect, layer));
  return { exit, ...seen };
};

const read = StoredToken.use((token) => token.read);
const write = (value: string | null) => StoredToken.use((token) => token.write(value));

const readFileText = (): string => readFileSync(file, "utf8");
const readFileObject = (): unknown => JSON.parse(readFileText());

const CONTROLLER_URL = "http://127.0.0.1:4937";

/** The settings of a connected app with no token stored. */
const writeConnectedSettings = (extra: object = {}) =>
  writeFileSync(file, JSON.stringify({ controllerUrl: CONTROLLER_URL, ...extra }));

/** Returns `text` as the fake Keychain encrypts it, in base64, as the settings file holds it. */
const sealedInBase64 = (text: string) => Buffer.from(`sealed:${text}`).toString("base64");

/** Returns `token`, stored for `controllerUrl`, as the settings file holds it. */
const storedTokenFor = (controllerUrl: string, token: string) =>
  sealedInBase64(JSON.stringify({ controllerUrl, token }));

describe("the stored token", () => {
  it("reads as null, with Sign Out disabled, when none is stored", async () => {
    writeConnectedSettings();
    expect(await runWithStoredToken(read)).toEqual({
      exit: Exit.succeed(null),
      signOutEnabled: [false],
      warnings: [],
    });
  });

  it("reads back what was written, and never stores it in plain text", async () => {
    writeConnectedSettings();
    const outcome = await runWithStoredToken(Effect.andThen(write("secret-token"), read));
    expect(outcome).toEqual({
      exit: Exit.succeed("secret-token"),
      signOutEnabled: [true, true],
      warnings: [],
    });
    expect(readFileObject()).toEqual({
      controllerUrl: CONTROLLER_URL,
      token: storedTokenFor(CONTROLLER_URL, "secret-token"),
    });
    expect(readFileText()).not.toContain("secret-token");
  });

  it("is removed when null is written, with Sign Out disabled", async () => {
    writeConnectedSettings({ token: storedTokenFor(CONTROLLER_URL, "secret-token") });
    const outcome = await runWithStoredToken(Effect.andThen(write(null), read));
    expect(outcome).toEqual({
      exit: Exit.succeed(null),
      signOutEnabled: [false, false],
      warnings: [],
    });
    expect(readFileObject()).toEqual({ controllerUrl: CONTROLLER_URL });
  });

  it("is removed, and reads as null, when the Keychain cannot decrypt it", async () => {
    writeConnectedSettings({ token: storedTokenFor(CONTROLLER_URL, "secret-token") });
    const outcome = await runWithStoredToken(read, true);
    expect(outcome).toEqual({ exit: Exit.succeed(null), signOutEnabled: [false], warnings: [] });
    expect(readFileObject()).toEqual({ controllerUrl: CONTROLLER_URL });
  });

  it.each<[string, object, object]>([
    [
      "it was stored for another controller URL than the saved one",
      {
        controllerUrl: "http://evil.example.com",
        token: storedTokenFor(CONTROLLER_URL, "secret-token"),
      },
      { controllerUrl: "http://evil.example.com" },
    ],
    ["no controller URL is saved", { token: storedTokenFor(CONTROLLER_URL, "secret-token") }, {}],
    [
      "it does not name the controller it was stored for",
      { controllerUrl: CONTROLLER_URL, token: sealedInBase64("secret-token") },
      { controllerUrl: CONTROLLER_URL },
    ],
  ])("is removed, and reads as null, when %s", async (_case, settings, after) => {
    writeFileSync(file, JSON.stringify(settings));
    expect(await runWithStoredToken(read)).toEqual({
      exit: Exit.succeed(null),
      signOutEnabled: [false],
      warnings: [],
    });
    expect(readFileObject()).toEqual(after);
  });

  it("is not stored when the Keychain cannot encrypt it, and a sheet tells the user", async () => {
    writeConnectedSettings();
    const before = readFileText();
    const outcome = await runWithStoredToken(write("secret-token"), true);
    expect(outcome).toEqual({
      exit: Exit.void,
      // The user stays signed in until the app quits, so Sign Out is enabled.
      signOutEnabled: [true],
      warnings: [
        "Hercule could not save your sign-in to the Keychain, so you will need to sign in again next time.",
      ],
    });
    expect(readFileText()).toBe(before);
  });

  it("is refused, and changes nothing, when no controller URL is saved", async () => {
    const outcome = await runWithStoredToken(write("secret-token"));
    expect(outcome).toEqual({
      exit: Exit.fail(new NoControllerSaved()),
      signOutEnabled: [],
      warnings: [],
    });
  });
});
