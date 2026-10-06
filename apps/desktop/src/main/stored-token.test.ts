import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { NoControllerSaved } from "./app-settings";
import { MainMenu } from "./menu";
import { KeychainError, SafeStorage } from "./safe-storage";
import { StoredToken, StoredTokenLayer } from "./stored-token";
import {
  makeFakeMainWindow,
  makeTemporarySettingsFile,
  type TemporarySettingsFile,
} from "./testing";
import { WaitingNotifications } from "./waiting-notifications";

let settingsFile: TemporarySettingsFile;

beforeEach(() => {
  settingsFile = makeTemporarySettingsFile();
  return settingsFile.remove;
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

/** What the fakes of the menu, the window and the notifications saw. */
interface Seen {
  /** Each signed-in state the menu was set to, in order. */
  readonly signedIn: Array<boolean>;
  /** Each signed-in state the notifications were set to, in order. */
  readonly notificationsSignedIn: Array<boolean>;
  /** Each call made to the window, in order; see FakeMainWindow. */
  readonly window: Array<string>;
}

/**
 * Runs `effect` against a token service built on the temporary settings file,
 * with a fake Keychain that fails when `keychainFailing` is true. Returns the
 * effect's exit and what the menu, the window and the notifications saw.
 */
const runWithStoredToken = async <A, E>(
  effect: Effect.Effect<A, E, StoredToken>,
  keychainFailing = false,
): Promise<{ exit: Exit.Exit<A, E> } & Seen> => {
  const signedIn: Array<boolean> = [];
  const notificationsSignedIn: Array<boolean> = [];
  const window = makeFakeMainWindow();
  const layer = StoredTokenLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        settingsFile.layer,
        makeFakeSafeStorage(keychainFailing),
        window.layer,
        Layer.succeed(MainMenu)({
          setSignedIn: (next) =>
            Effect.sync(() => {
              signedIn.push(next);
            }),
          setGoItems: () => Effect.void,
        }),
        Layer.succeed(WaitingNotifications)({
          setSignedIn: (next) =>
            Effect.sync(() => {
              notificationsSignedIn.push(next);
            }),
          setWaitingRequests: () => Effect.void,
        }),
      ),
    ),
  );
  const exit = await Effect.runPromiseExit(Effect.provide(effect, layer));
  return { exit, signedIn, notificationsSignedIn, window: window.calls };
};

const read = StoredToken.use((token) => token.read);
const write = (value: string | null) => StoredToken.use((token) => token.write(value));

const readFileText = (): string => readFileSync(settingsFile.path, "utf8");
const readFileObject = (): unknown => JSON.parse(readFileText());

const CONTROLLER_URL = "http://127.0.0.1:4937";

/** The settings of a connected app with no token stored. */
const writeConnectedSettings = (extra: object = {}) =>
  writeFileSync(settingsFile.path, JSON.stringify({ controllerUrl: CONTROLLER_URL, ...extra }));

/** Returns `text` as the fake Keychain encrypts it, in base64, as the settings file holds it. */
const sealedInBase64 = (text: string) => Buffer.from(`sealed:${text}`).toString("base64");

/** Returns `token`, stored for `controllerUrl`, as the settings file holds it. */
const storedTokenFor = (controllerUrl: string, token: string) =>
  sealedInBase64(JSON.stringify({ controllerUrl, token }));

describe("the stored token", () => {
  it("reads as null, and tells the menu and the notifications that the user is signed out, when none is stored", async () => {
    writeConnectedSettings();
    expect(await runWithStoredToken(read)).toEqual({
      exit: Exit.succeed(null),
      signedIn: [false],
      notificationsSignedIn: [false],
      window: [],
    });
  });

  it("reads back what was written, and never stores it in plain text", async () => {
    writeConnectedSettings();
    const outcome = await runWithStoredToken(Effect.andThen(write("secret-token"), read));
    expect(outcome).toEqual({
      exit: Exit.succeed("secret-token"),
      signedIn: [true, true],
      notificationsSignedIn: [true, true],
      window: [],
    });
    expect(readFileObject()).toEqual({
      controllerUrl: CONTROLLER_URL,
      token: storedTokenFor(CONTROLLER_URL, "secret-token"),
    });
    expect(readFileText()).not.toContain("secret-token");
  });

  it("is removed when null is written, and tells the menu and the notifications that the user signed out", async () => {
    writeConnectedSettings({ token: storedTokenFor(CONTROLLER_URL, "secret-token") });
    const outcome = await runWithStoredToken(Effect.andThen(write(null), read));
    expect(outcome).toEqual({
      exit: Exit.succeed(null),
      signedIn: [false, false],
      notificationsSignedIn: [false, false],
      window: [],
    });
    expect(readFileObject()).toEqual({ controllerUrl: CONTROLLER_URL });
  });

  it("stays removed when the user signs out while the sign-in before is still being saved", async () => {
    writeConnectedSettings();
    const outcome = await runWithStoredToken(
      Effect.andThen(
        Effect.all([write("secret-token"), write(null)], { concurrency: "unbounded" }),
        read,
      ),
    );
    expect(outcome).toEqual({
      exit: Exit.succeed(null),
      signedIn: [true, false, false],
      notificationsSignedIn: [true, false, false],
      window: [],
    });
    expect(readFileObject()).toEqual({ controllerUrl: CONTROLLER_URL });
  });

  it("is removed, and reads as null, when the Keychain cannot decrypt it", async () => {
    writeConnectedSettings({ token: storedTokenFor(CONTROLLER_URL, "secret-token") });
    const outcome = await runWithStoredToken(read, true);
    expect(outcome).toEqual({
      exit: Exit.succeed(null),
      signedIn: [false],
      notificationsSignedIn: [false],
      window: [],
    });
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
    writeFileSync(settingsFile.path, JSON.stringify(settings));
    expect(await runWithStoredToken(read)).toEqual({
      exit: Exit.succeed(null),
      signedIn: [false],
      notificationsSignedIn: [false],
      window: [],
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
      signedIn: [true],
      notificationsSignedIn: [true],
      window: [
        "showWarning Hercule could not save your sign-in to the Keychain, so you will need to sign in again next time.",
      ],
    });
    expect(readFileText()).toBe(before);
  });

  it("is refused, and changes nothing, when no controller URL is saved", async () => {
    const outcome = await runWithStoredToken(write("secret-token"));
    expect(outcome).toEqual({
      exit: Exit.fail(new NoControllerSaved("a login token")),
      signedIn: [],
      notificationsSignedIn: [],
      window: [],
    });
  });
});
