import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import {
  AppSettings,
  makeAppSettingsLayer,
  NoControllerSaved,
  type WindowState,
} from "./app-settings";

let folder: string;
let file: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), "hercule-desktop-settings-"));
  file = join(folder, "settings.json");
});

afterEach(() => {
  rmSync(folder, { recursive: true, force: true });
});

/**
 * Runs `effect` against a settings service built on `file`, as main builds it
 * at start, on `fileSystem`: Node's file system unless a test passes another.
 */
const runWithAppSettings = <A, E>(
  effect: Effect.Effect<A, E, AppSettings>,
  fileSystem: Layer.Layer<FileSystem.FileSystem> = NodeFileSystem.layer,
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(effect, makeAppSettingsLayer(file).pipe(Layer.provide(fileSystem))),
  );

const readBoth = Effect.gen(function* () {
  const settings = yield* AppSettings;
  return {
    controllerUrl: yield* settings.readControllerUrl,
    window: yield* settings.readWindowState,
  };
});

const saveWindowState = (state: WindowState) =>
  AppSettings.use((settings) => settings.saveWindowState(state));

const readFileObject = (): unknown => JSON.parse(readFileSync(file, "utf8"));

const windowState: WindowState = {
  bounds: { x: 40, y: 60, width: 1440, height: 900 },
  fullScreen: false,
};

/**
 * Builds a file system that works as Node's does and records, in `calls`,
 * each flush of an open file to the disk and each rename, by file name.
 */
const makeRecordingFileSystem = (calls: Array<string>): Layer.Layer<FileSystem.FileSystem> =>
  Layer.effect(FileSystem.FileSystem)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const record = (call: string) => Effect.sync(() => calls.push(call));
      return FileSystem.FileSystem.of({
        ...fs,
        open: (path, options) =>
          fs.open(path, options).pipe(
            Effect.map(
              (handle): FileSystem.File =>
                Object.create(handle, {
                  sync: { get: () => Effect.tap(handle.sync, record(`sync ${basename(path)}`)) },
                }) as FileSystem.File,
            ),
          ),
        rename: (from, to) =>
          Effect.tap(fs.rename(from, to), record(`rename ${basename(from)} ${basename(to)}`)),
      });
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer));

describe("the app's settings", () => {
  it("are empty before the file exists", async () => {
    expect(await runWithAppSettings(readBoth)).toEqual({ controllerUrl: null, window: null });
  });

  it("are read from the file", async () => {
    writeFileSync(
      file,
      JSON.stringify({ controllerUrl: "http://127.0.0.1:4937", window: windowState }),
    );
    expect(await runWithAppSettings(readBoth)).toEqual({
      controllerUrl: "http://127.0.0.1:4937",
      window: windowState,
    });
  });

  it.each([
    ["text that is not JSON", "{ controllerUrl: "],
    ["JSON that is not an object", JSON.stringify([windowState])],
  ])("are empty when the file holds %s", async (_case, text) => {
    writeFileSync(file, text);
    expect(await runWithAppSettings(readBoth)).toEqual({ controllerUrl: null, window: null });
  });

  it.each([
    ["is not http or https", "file:///x"],
    ["is not a URL", "127.0.0.1:4937"],
  ])("ignore a controller URL that %s, and keep the window state", async (_case, url) => {
    writeFileSync(file, JSON.stringify({ controllerUrl: url, window: windowState }));
    expect(await runWithAppSettings(readBoth)).toEqual({
      controllerUrl: null,
      window: windowState,
    });
  });

  it.each([
    ["no width", { ...windowState, bounds: { ...windowState.bounds, width: 0 } }],
    ["no full-screen flag", { bounds: windowState.bounds }],
  ])("ignore a window state with %s, and keep the controller URL", async (_case, window) => {
    writeFileSync(file, JSON.stringify({ controllerUrl: "https://hercule.example", window }));
    expect(await runWithAppSettings(readBoth)).toEqual({
      controllerUrl: "https://hercule.example",
      window: null,
    });
  });

  it("save the window state beside the saved controller URL, as indented JSON", async () => {
    writeFileSync(file, JSON.stringify({ controllerUrl: "https://hercule.example" }));
    const saved = { ...windowState, fullScreen: true };
    const afterSave = await runWithAppSettings(Effect.andThen(saveWindowState(saved), readBoth));
    expect(afterSave).toEqual({ controllerUrl: "https://hercule.example", window: saved });
    expect(readFileSync(file, "utf8")).toBe(
      JSON.stringify({ controllerUrl: "https://hercule.example", window: saved }, null, 2),
    );
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("keep the keys a save does not change, those they ignored and unknown ones included", async () => {
    const newerKey = { theme: "orient-express", panes: [1, 2] };
    writeFileSync(
      file,
      JSON.stringify({ controllerUrl: "file:///x", window: windowState, newerKey }),
    );
    const saved = { ...windowState, fullScreen: true };
    await runWithAppSettings(saveWindowState(saved));
    expect(readFileObject()).toEqual({ controllerUrl: "file:///x", window: saved, newerKey });
  });

  it("replace a file that did not decode on the next save", async () => {
    writeFileSync(file, "not json");
    await runWithAppSettings(saveWindowState(windowState));
    expect(readFileObject()).toEqual({ window: windowState });
  });

  it("keep every change when saves overlap", async () => {
    const other = { ...windowState, fullScreen: true };
    await runWithAppSettings(
      Effect.all([saveWindowState(windowState), saveWindowState(other)], {
        concurrency: "unbounded",
      }),
    );
    expect(readFileObject()).toEqual({ window: other });
  });

  it("flush the temporary file to the disk before renaming it over the file", async () => {
    const calls: Array<string> = [];
    await runWithAppSettings(saveWindowState(windowState), makeRecordingFileSystem(calls));
    expect(calls).toEqual(["sync settings.json.tmp", "rename settings.json.tmp settings.json"]);
  });

  it("remove the temporary file, and keep the state saved before, when the rename fails", async () => {
    // A folder that is not empty cannot be replaced by a file, so the rename
    // over it fails.
    mkdirSync(join(file, "in-the-way"), { recursive: true });
    const outcome = await runWithAppSettings(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(saveWindowState(windowState));
        return { failed: Exit.isFailure(exit), settings: yield* readBoth };
      }),
    );
    expect(outcome).toEqual({ failed: true, settings: { controllerUrl: null, window: null } });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });
});

describe("the controller URL and the token", () => {
  const encrypted = new Uint8Array([0, 1, 2, 254, 255]);
  const encryptedInBase64 = "AAEC/v8=";

  const readUrlAndToken = Effect.gen(function* () {
    const settings = yield* AppSettings;
    return {
      controllerUrl: yield* settings.readControllerUrl,
      token: yield* settings.readEncryptedToken,
    };
  });

  const saveControllerUrl = (origin: string) =>
    AppSettings.use((settings) => settings.saveControllerUrl(origin));

  const saveEncryptedToken = (token: Uint8Array | null) =>
    AppSettings.use((settings) => settings.saveEncryptedToken(token));

  it("read the token from the file, in base64", async () => {
    writeFileSync(
      file,
      JSON.stringify({ controllerUrl: "http://127.0.0.1:4937", token: encryptedInBase64 }),
    );
    expect(await runWithAppSettings(readUrlAndToken)).toEqual({
      controllerUrl: "http://127.0.0.1:4937",
      token: encrypted,
    });
  });

  it("ignore a token that is not base64", async () => {
    writeFileSync(file, JSON.stringify({ controllerUrl: "http://127.0.0.1:4937", token: "?!" }));
    expect(await runWithAppSettings(readUrlAndToken)).toEqual({
      controllerUrl: "http://127.0.0.1:4937",
      token: null,
    });
  });

  it("save the token beside the controller URL, in base64", async () => {
    writeFileSync(file, JSON.stringify({ controllerUrl: "http://127.0.0.1:4937" }));
    const afterSave = await runWithAppSettings(
      Effect.andThen(saveEncryptedToken(encrypted), readUrlAndToken),
    );
    expect(afterSave).toEqual({ controllerUrl: "http://127.0.0.1:4937", token: encrypted });
    expect(readFileObject()).toEqual({
      controllerUrl: "http://127.0.0.1:4937",
      token: encryptedInBase64,
    });
  });

  it("remove the token", async () => {
    writeFileSync(
      file,
      JSON.stringify({ controllerUrl: "http://127.0.0.1:4937", token: encryptedInBase64 }),
    );
    const afterSave = await runWithAppSettings(
      Effect.andThen(saveEncryptedToken(null), readUrlAndToken),
    );
    expect(afterSave).toEqual({ controllerUrl: "http://127.0.0.1:4937", token: null });
    expect(readFileObject()).toEqual({ controllerUrl: "http://127.0.0.1:4937" });
  });

  it("refuse to save a token with no controller URL saved, and write nothing", async () => {
    const exit = await runWithAppSettings(Effect.exit(saveEncryptedToken(encrypted)));
    expect(exit).toEqual(Exit.fail(new NoControllerSaved()));
    expect(existsSync(file)).toBe(false);
  });

  it("remove a token whose controller URL did not decode", async () => {
    writeFileSync(file, JSON.stringify({ controllerUrl: "file:///x", token: encryptedInBase64 }));
    await runWithAppSettings(saveEncryptedToken(null));
    expect(readFileObject()).toEqual({ controllerUrl: "file:///x" });
  });

  it("keep the token when the same controller is saved again", async () => {
    writeFileSync(
      file,
      JSON.stringify({ controllerUrl: "http://127.0.0.1:4937", token: encryptedInBase64 }),
    );
    const afterSave = await runWithAppSettings(
      Effect.andThen(saveControllerUrl("http://127.0.0.1:4937"), readUrlAndToken),
    );
    expect(afterSave).toEqual({ controllerUrl: "http://127.0.0.1:4937", token: encrypted });
    expect(readFileObject()).toEqual({
      controllerUrl: "http://127.0.0.1:4937",
      token: encryptedInBase64,
    });
  });

  it("drop the token in the same write when a different controller is saved", async () => {
    writeFileSync(
      file,
      JSON.stringify({ controllerUrl: "http://127.0.0.1:4937", token: encryptedInBase64 }),
    );
    const calls: Array<string> = [];
    const afterSave = await runWithAppSettings(
      Effect.andThen(saveControllerUrl("https://hercule.example"), readUrlAndToken),
      makeRecordingFileSystem(calls),
    );
    expect(afterSave).toEqual({ controllerUrl: "https://hercule.example", token: null });
    expect(readFileObject()).toEqual({ controllerUrl: "https://hercule.example" });
    expect(calls).toEqual(["sync settings.json.tmp", "rename settings.json.tmp settings.json"]);
  });

  it("keep the window state and unknown keys when the controller and the token change", async () => {
    const newerKey = { theme: "orient-express" };
    writeFileSync(
      file,
      JSON.stringify({
        controllerUrl: "http://127.0.0.1:4937",
        token: encryptedInBase64,
        window: windowState,
        newerKey,
      }),
    );
    await runWithAppSettings(
      Effect.andThen(saveControllerUrl("https://hercule.example"), saveEncryptedToken(encrypted)),
    );
    expect(readFileObject()).toEqual({
      controllerUrl: "https://hercule.example",
      token: encryptedInBase64,
      window: windowState,
      newerKey,
    });
  });
});
