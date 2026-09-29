/**
 * The app's settings file: the one small file main keeps in the app's user
 * data folder, `settings.json`. It holds the saved controller URL and the
 * window's state.
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
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { isHttpUrl } from "./http-url";

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

/**
 * Builds the settings service on the file at `file`, reading the file once.
 * Saves run one at a time, and a save that has started finishes even when
 * main shuts down during it.
 */
const make = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let settings = yield* readSettingsFile(fs, file);
    const controllerUrl = yield* decodeSettingsKey(ControllerUrl, settings, "controllerUrl", file);
    let windowState = yield* decodeSettingsKey(WindowState, settings, "window", file);
    const fileWriteLock = yield* Semaphore.make(1);

    return {
      /** Returns the saved controller URL, or `null` before one has been saved. */
      readControllerUrl: Effect.sync(() => controllerUrl),

      /** Returns the saved window state, or `null` before the window was first saved. */
      readWindowState: Effect.sync(() => windowState),

      /**
       * Saves the window state. Fails when the file cannot be written, and
       * then keeps the state saved before.
       */
      saveWindowState: (state: WindowState) =>
        // The new settings are built only once the save holds the lock, so a
        // save never writes over another's change.
        Effect.gen(function* () {
          // Both schemas encode every value of their type.
          const window = yield* Effect.orDie(Schema.encodeEffect(WindowState)(state));
          const next = { ...settings, window };
          const text = yield* Effect.orDie(Schema.encodeEffect(SettingsFileJson)(next));
          yield* writeFileAtomically(fs, file, text);
          settings = next;
          windowState = state;
        }).pipe(Effect.uninterruptible, fileWriteLock.withPermits(1)),
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
