/**
 * The login token the renderer's client uses, stored between launches in the
 * settings file, encrypted with the Keychain's key. Spec 17 (§Auth and the
 * token) owns the rules:
 *
 * - The token is never stored in plain text. When the Keychain cannot
 *   encrypt it, nothing is stored, and the user signs in again at the next
 *   launch.
 * - The token is encrypted together with the controller URL it was stored
 *   for, and read back only while that URL is the saved one. Otherwise a
 *   program that edits the settings file could change the saved URL, and the
 *   app would send the token to a server of that program's choosing.
 * - Sign Out in the menu is enabled exactly while the renderer holds a token:
 *   every read and every write sets it.
 *
 * This module imports no Electron, so it is unit tested with fakes of the
 * services it uses.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { AppSettings, NoControllerSaved } from "./app-settings";
import { MainWindow } from "./main-window";
import { MainMenu } from "./menu";
import { SafeStorage } from "./safe-storage";

/** What the sheet says when the Keychain cannot encrypt the token. */
const KEYCHAIN_WARNING =
  "Hercule could not save your sign-in to the Keychain, so you will need to sign in again next time.";

/** What the Keychain encrypts: the login token and the controller URL it was stored for, as JSON. */
const TokenForController = Schema.fromJsonString(
  Schema.Struct({ controllerUrl: Schema.String, token: Schema.NonEmptyString }),
);
const encodeTokenForController = Schema.encodeSync(TokenForController);
const decodeTokenForController = Schema.decodeUnknownOption(TokenForController);

/** Builds the token service on the settings file, the Keychain, the menu and the window. */
const make = Effect.gen(function* () {
  const settings = yield* AppSettings;
  const safeStorage = yield* SafeStorage;
  const menu = yield* MainMenu;
  const window = yield* MainWindow;

  /**
   * Logs that the stored token is removed and why, `reason`, removes it, and
   * returns null. A removal that fails is logged too: the token is then
   * removed at the next read.
   */
  const removeStoredToken = (reason: string): Effect.Effect<null> =>
    Effect.logWarning(`Removing the stored login token, because ${reason}.`).pipe(
      Effect.andThen(settings.saveEncryptedToken(null)),
      Effect.catch((error) =>
        Effect.logWarning(`Could not remove the stored login token: ${error.message}`),
      ),
      Effect.as(null),
    );

  /**
   * Returns the stored token, decrypted, or null when none is stored. Removes
   * the stored token, logs why, and returns null, so that the user signs in
   * again, when:
   *
   * - no controller URL is saved;
   * - the Keychain cannot decrypt the token, because its key changed or
   *   access was denied;
   * - the token was stored for another controller URL than the saved one.
   */
  const decryptStoredToken: Effect.Effect<string | null> = Effect.gen(function* () {
    const encrypted = yield* settings.readEncryptedToken;
    if (encrypted === null) return null;
    const controllerUrl = yield* settings.readControllerUrl;
    if (controllerUrl === null) return yield* removeStoredToken("no controller URL is saved");
    const decrypted = yield* Effect.result(safeStorage.decrypt(encrypted));
    if (Result.isFailure(decrypted)) {
      return yield* removeStoredToken(
        `the Keychain could not decrypt it: ${decrypted.failure.message}`,
      );
    }
    const stored = decodeTokenForController(decrypted.success);
    if (Option.isNone(stored)) {
      return yield* removeStoredToken("it does not name the controller it was stored for");
    }
    if (stored.value.controllerUrl !== controllerUrl) {
      return yield* removeStoredToken(
        `it was stored for ${stored.value.controllerUrl}, and the saved controller is ${controllerUrl}`,
      );
    }
    return stored.value.token;
  });

  /**
   * Encrypts `token` together with the saved controller URL, and stores it.
   * When the Keychain cannot encrypt it, stores nothing and shows the user a
   * warning sheet. Fails with NoControllerSaved when no controller URL is
   * saved.
   */
  const encryptAndStore = (token: string): Effect.Effect<void, NoControllerSaved> =>
    Effect.gen(function* () {
      const controllerUrl = yield* settings.readControllerUrl;
      if (controllerUrl === null) return yield* new NoControllerSaved();
      yield* safeStorage.encrypt(encodeTokenForController({ controllerUrl, token })).pipe(
        Effect.matchEffect({
          onFailure: (error) =>
            Effect.logWarning(
              `Did not store the login token, because the Keychain could not encrypt it: ${error.message}`,
            ).pipe(Effect.andThen(window.showWarning(KEYCHAIN_WARNING))),
          onSuccess: settings.saveEncryptedToken,
        }),
        // The settings file is in the app's own folder, so a write that fails
        // is a defect.
        Effect.catchTag("PlatformError", Effect.die),
      );
    });

  return {
    /**
     * Returns the stored login token, or null when none is stored, and
     * enables Sign Out exactly when a token is returned. A token that cannot
     * be used, such as one stored for another controller URL, is removed and
     * reads as null; see decryptStoredToken.
     */
    read: Effect.tap(decryptStoredToken, (token) => menu.setSignOutEnabled(token !== null)),

    /**
     * Stores `token`, encrypted, or removes the stored token when `token` is
     * null, and enables Sign Out exactly when `token` is not null. When the
     * Keychain cannot encrypt the token, stores nothing and shows the user a
     * warning sheet; the user stays signed in until the app quits.
     *
     * Fails with NoControllerSaved, and changes nothing, when a token is given
     * and no controller URL is saved.
     */
    write: (token: string | null): Effect.Effect<void, NoControllerSaved> =>
      (token === null
        ? settings.saveEncryptedToken(null).pipe(Effect.catchTag("PlatformError", Effect.die))
        : encryptAndStore(token)
      ).pipe(Effect.andThen(menu.setSignOutEnabled(token !== null))),
  };
});

/** The stored login token. */
export class StoredToken extends Context.Service<StoredToken, Effect.Success<typeof make>>()(
  "hercule/desktop/StoredToken",
) {}

/** Builds the token service; see `make`. */
export const StoredTokenLayer: Layer.Layer<
  StoredToken,
  never,
  AppSettings | SafeStorage | MainMenu | MainWindow
> = Layer.effect(StoredToken)(make);
