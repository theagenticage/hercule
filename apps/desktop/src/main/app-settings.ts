/**
 * The app's settings file: the one small file main keeps in the app's user
 * data folder, `settings.json`. It holds the saved controller URL, the login
 * token as the Keychain encrypted it, the window's state, the steps of the
 * first run the user put off, and the Appearance. The token sits beside the URL of the
 * controller it belongs to, so that one write changes both.
 *
 * The file is read once, when main starts, and kept in memory; reads never
 * touch the disk. Every save writes the whole file again.
 *
 * The file is a JSON object, and each of its keys is decoded on its own. A key
 * whose value does not decode is ignored, and costs only itself: a bad
 * controller URL does not throw away a good window state. A save writes back
 * every key it does not change as it found it, those it could not decode and
 * those this build does not know alike, so settings written by a newer build
 * survive a run of an older one.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Appearance, FirstRunProgress } from "../ipc/contract";
import { DEFAULT_APPEARANCE } from "../ipc/appearance";
import { isHttpUrl } from "../ipc/http-url";

/**
 * The Appearance as the settings file holds it. A file saved by an older
 * build may hold `openOn: "threads"`, the name the choice "Where I left off"
 * had before; it reads as `"lastScreen"`. Without this, the whole Appearance
 * of such a file would fail to decode, and the user would lose their theme
 * and glass along with it. A save always writes `"lastScreen"`.
 */
const StoredAppearance = Schema.Struct({
  ...Appearance.fields,
  openOn: Schema.Union([
    Appearance.fields.openOn,
    Schema.Literal("threads").transform("lastScreen"),
  ]),
});

/** The URL of the controller the app connects to. */
const ControllerUrl = Schema.String.check(
  Schema.makeFilter((url: string) =>
    isHttpUrl(url)
      ? undefined
      : `A controller URL is an http: or https: URL. Invalid value: ${url}`,
  ),
);

/** The length of one side of a rectangle on the screen, in points: always more than zero. */
const SideLength = Schema.Int.check(Schema.isGreaterThan(0));

/** A rectangle on the screen, in points, as Electron measures windows and displays. */
export const Bounds = Schema.Struct({
  x: Schema.Int,
  y: Schema.Int,
  width: SideLength,
  height: SideLength,
});
export type Bounds = typeof Bounds.Type;

/**
 * The window's state, saved so that the next launch opens the window as it
 * was. `bounds` are the window's normal bounds: where it sits when it is not
 * full screen.
 */
export const WindowState = Schema.Struct({
  bounds: Bounds,
  fullScreen: Schema.Boolean,
});
export type WindowState = typeof WindowState.Type;

/**
 * The login token as the Keychain encrypted it. The file holds it in base64,
 * so it is the only key a person cannot read.
 */
const EncryptedToken = Schema.Uint8ArrayFromBase64;

/**
 * The error a request fails with when it needs a saved controller URL and
 * none is saved. `what` names the thing that belongs to one controller, such
 * as "a login token": there is no controller to save it for or read it from.
 * The message completes a sentence, such as a refused IPC message's.
 */
export class NoControllerSaved extends Data.TaggedError("NoControllerSaved")<{
  readonly message: string;
}> {
  constructor(what: string) {
    super({ message: `no controller URL is saved, and ${what} belongs to one controller` });
  }
}

/** The settings file's text: a JSON object, indented so that a person can read it. */
const SettingsFileJson = Schema.fromJsonString(Schema.JsonObject, { space: 2 });
type SettingsFileObject = typeof Schema.JsonObject.Type;

/**
 * Reads the settings file and returns the JSON object it holds. Returns an
 * empty object when the file does not exist yet, and also when it cannot be
 * read or does not hold a JSON object. The second case is logged: the next
 * save then replaces the file, and all that is lost is the window's position
 * or a controller URL the user types again.
 */
const readSettingsFile = (
  fs: FileSystem.FileSystem,
  file: string,
): Effect.Effect<SettingsFileObject> =>
  fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingsFileJson)),
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeed({})
        : Effect.as(Effect.logWarning(`Ignoring the settings in ${file}: ${error.message}`), {}),
    ),
  );

/**
 * Decodes the value of `key` in `settings`, the JSON object read from `file`,
 * with `schema`. Returns null when the key is absent, and also when its value
 * does not decode; that case is logged.
 */
const decodeSettingsKey = <T, E>(
  schema: Schema.Codec<T, E>,
  settings: SettingsFileObject,
  key: string,
  file: string,
): Effect.Effect<T | null> =>
  Object.hasOwn(settings, key)
    ? Schema.decodeUnknownEffect(schema)(settings[key]).pipe(
        Effect.catch((error) =>
          Effect.as(Effect.logWarning(`Ignoring ${key} in ${file}: ${error.message}`), null),
        ),
      )
    : Effect.succeed(null);

/**
 * Writes `text` to `file` so that the file is never left half written, even
 * when the machine loses power: it writes a temporary file beside `file`,
 * flushes that to the disk, and renames it over `file`. Fails when a step
 * fails, after removing the temporary file.
 */
const writeFileAtomically = (
  fs: FileSystem.FileSystem,
  file: string,
  text: string,
): Effect.Effect<void, PlatformError> => {
  const temporaryFile = `${file}.tmp`;
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(temporaryFile, { flag: "w" });
      yield* handle.writeAll(new TextEncoder().encode(text));
      yield* handle.sync;
    }),
  ).pipe(
    Effect.andThen(fs.rename(temporaryFile, file)),
    Effect.onError(() => Effect.ignore(fs.remove(temporaryFile, { force: true }))),
  );
};

/** Returns a copy of `settings` without `key`. */
const removeSettingsKey = (settings: SettingsFileObject, key: string): SettingsFileObject =>
  Object.fromEntries(Object.entries(settings).filter(([name]) => name !== key));

/**
 * Builds the settings service on the file at `file`, reading the file once.
 * Saves run one at a time, and a save that has started finishes even when
 * main shuts down during it.
 */
const make = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let settings = yield* readSettingsFile(fs, file);
    let controllerUrl = yield* decodeSettingsKey(ControllerUrl, settings, "controllerUrl", file);
    let encryptedToken = yield* decodeSettingsKey(EncryptedToken, settings, "token", file);
    let windowState = yield* decodeSettingsKey(WindowState, settings, "window", file);
    let firstRun = yield* decodeSettingsKey(FirstRunProgress, settings, "firstRun", file);
    let appearance =
      (yield* decodeSettingsKey(StoredAppearance, settings, "appearance", file)) ??
      DEFAULT_APPEARANCE;
    const fileWriteLock = yield* Semaphore.make(1);

    /**
     * Runs `save` on its own, after any save under way, and lets it finish
     * once it has started. A save builds the new settings only once it runs,
     * so it never writes over another save's change.
     */
    const runSave = <E>(save: Effect.Effect<void, E>): Effect.Effect<void, E> =>
      save.pipe(Effect.uninterruptible, fileWriteLock.withPermits(1));

    /**
     * Writes `next` to the file, and then makes it the settings in memory.
     * Fails when the file cannot be written, and then keeps the settings
     * saved before.
     */
    const writeSettings = (next: SettingsFileObject): Effect.Effect<void, PlatformError> =>
      Effect.gen(function* () {
        // The schema encodes every JSON object.
        const text = yield* Effect.orDie(Schema.encodeEffect(SettingsFileJson)(next));
        yield* writeFileAtomically(fs, file, text);
        settings = next;
      });

    return {
      /** Returns the saved controller URL, or `null` before one has been saved. */
      readControllerUrl: Effect.sync(() => controllerUrl),

      /**
       * Saves `origin`, the origin of a controller, as the controller URL.
       * When `origin` differs from the saved controller URL, the same write
       * removes the stored token and the first run's progress, which belong
       * to the controller saved before. Fails when the file cannot be
       * written, and then keeps the settings saved before.
       */
      saveControllerUrl: (origin: string) =>
        runSave(
          Effect.gen(function* () {
            // An origin is an http or https URL, so the schema encodes it.
            const encoded = yield* Effect.orDie(Schema.encodeEffect(ControllerUrl)(origin));
            const sameController = origin === controllerUrl;
            const kept = sameController
              ? settings
              : removeSettingsKey(removeSettingsKey(settings, "token"), "firstRun");
            yield* writeSettings({ ...kept, controllerUrl: encoded });
            controllerUrl = origin;
            if (!sameController) {
              encryptedToken = null;
              firstRun = null;
            }
          }),
        ),

      /** Returns the stored token, as the Keychain encrypted it, or `null` when none is stored. */
      readEncryptedToken: Effect.sync(() => encryptedToken),

      /**
       * Saves `encrypted`, the login token as the Keychain encrypted it, or
       * removes the stored token when `encrypted` is `null`.
       *
       * Fails with NoControllerSaved when a token is given and no controller
       * URL is saved. Removing always works, even with no controller URL, so
       * that a token whose URL was lost can still be removed. Fails when the
       * file cannot be written, and then keeps the token saved before.
       */
      saveEncryptedToken: (encrypted: Uint8Array | null) =>
        runSave(
          Effect.gen(function* () {
            if (encrypted === null) {
              yield* writeSettings(removeSettingsKey(settings, "token"));
            } else {
              if (controllerUrl === null) return yield* new NoControllerSaved("a login token");
              // The schema encodes every byte array.
              const token = yield* Effect.orDie(Schema.encodeEffect(EncryptedToken)(encrypted));
              yield* writeSettings({ ...settings, token });
            }
            encryptedToken = encrypted;
          }),
        ),

      /** Returns the saved window state, or `null` before the window was first saved. */
      readWindowState: Effect.sync(() => windowState),

      /**
       * Saves the window state. Fails when the file cannot be written, and
       * then keeps the state saved before.
       */
      saveWindowState: (state: WindowState) =>
        runSave(
          Effect.gen(function* () {
            // The schema encodes every value of its type.
            const window = yield* Effect.orDie(Schema.encodeEffect(WindowState)(state));
            yield* writeSettings({ ...settings, window });
            windowState = state;
          }),
        ),

      /**
       * Returns what main keeps of the first run for the saved controller, or
       * `null` when it keeps nothing.
       */
      readFirstRunProgress: Effect.sync(() => firstRun),

      /**
       * Saves `progress` as what main keeps of the first run for the saved
       * controller, or removes it when `progress` is `null`.
       *
       * Fails with NoControllerSaved when `progress` is given and no
       * controller URL is saved. Fails when the file cannot be written, and
       * then keeps what was saved before.
       */
      saveFirstRunProgress: (progress: FirstRunProgress | null) =>
        runSave(
          Effect.gen(function* () {
            if (progress === null) {
              yield* writeSettings(removeSettingsKey(settings, "firstRun"));
              firstRun = null;
              return;
            }
            if (controllerUrl === null) {
              return yield* new NoControllerSaved("the first run's progress");
            }
            // The schema encodes every value of its type.
            const encoded = yield* Effect.orDie(Schema.encodeEffect(FirstRunProgress)(progress));
            yield* writeSettings({ ...settings, firstRun: encoded });
            firstRun = progress;
          }),
        ),

      /** Returns the saved Appearance, or the defaults when none is saved. */
      readAppearance: Effect.sync(() => appearance),

      /**
       * Saves the Appearance. Fails when the file cannot be written, and then
       * keeps the Appearance saved before.
       */
      saveAppearance: (next: Appearance) =>
        runSave(
          Effect.gen(function* () {
            // The schema encodes every value of its type.
            const encoded = yield* Effect.orDie(Schema.encodeEffect(StoredAppearance)(next));
            yield* writeSettings({ ...settings, appearance: encoded });
            appearance = next;
          }),
        ),
    };
  });

/** The app's settings file, read once at start and written on every save. */
export class AppSettings extends Context.Service<
  AppSettings,
  Effect.Success<ReturnType<typeof make>>
>()("hercule/desktop/AppSettings") {}

/** Builds the settings service on the settings file at `file`. */
export const makeAppSettingsLayer = (
  file: string,
): Layer.Layer<AppSettings, never, FileSystem.FileSystem> => Layer.effect(AppSettings)(make(file));
