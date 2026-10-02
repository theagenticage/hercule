import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ControllerConnection } from "./controller-connection";
import { FirstRun, makeFirstRunLayer } from "./first-run";
import {
  makeFakeMainWindow,
  makeTemporarySettingsFile,
  type TemporarySettingsFile,
} from "./testing";

let settingsFile: TemporarySettingsFile;

beforeEach(() => {
  settingsFile = makeTemporarySettingsFile();
  return settingsFile.remove;
});

describe("FirstRun", () => {
  it("imports its services when first used, and runs each method on them", async () => {
    const window = makeFakeMainWindow();
    const layer = makeFirstRunLayer({
      // No binary is there, as on a Mac where Hercule is not installed.
      binaryPath: join(settingsFile.path, "..", "no-binary-here"),
      openFolder: () => Effect.die("not used"),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          settingsFile.layer,
          window.layer,
          Layer.succeed(ControllerConnection)({
            save: () => Effect.die("not used"),
            saveIfAnswering: () => Effect.die("not used"),
            takePastedSetupToken: () => Effect.die("not used"),
          }),
        ),
      ),
    );
    const outcomes = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const firstRun = yield* FirstRun;
          return {
            found: yield* firstRun.findLocalController,
            started: yield* firstRun.startLocalController,
            picked: yield* firstRun.pickFolder,
          };
        }),
        layer,
      ),
    );
    expect(outcomes).toEqual({
      found: { _tag: "Fresh", problem: null },
      started: { _tag: "NotInstalled" },
      picked: { _tag: "Cancelled" },
    });
    expect(window.calls).toEqual(["pickFolder"]);
  });
});
