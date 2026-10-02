import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ControllerConnection } from "./controller-connection";
import {
  makeFakeMainWindow,
  makeTemporarySettingsFile,
  type TemporarySettingsFile,
} from "./testing";
import { makeThisMacLayer, ThisMac } from "./this-mac";

let settingsFile: TemporarySettingsFile;

beforeEach(() => {
  settingsFile = makeTemporarySettingsFile();
  return settingsFile.remove;
});

describe("ThisMac", () => {
  it("runs each method on a Mac where Hercule is not installed", async () => {
    const window = makeFakeMainWindow();
    const layer = makeThisMacLayer({
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
            check: () => Effect.die("not used"),
            saveAndReload: () => Effect.die("not used"),
            takePastedSetupToken: () => Effect.die("not used"),
          }),
        ),
      ),
    );
    const outcomes = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const thisMac = yield* ThisMac;
          return {
            found: yield* thisMac.findLocalController,
            started: yield* thisMac.startLocalController,
            logsShown: (yield* Effect.flip(thisMac.showLogsFolder))._tag,
            tokenRead: (yield* Effect.flip(thisMac.readSetupToken))._tag,
            picked: yield* thisMac.pickFolder,
          };
        }),
        layer,
      ),
    );
    expect(outcomes).toEqual({
      found: { _tag: "NotFound", line: null },
      started: { _tag: "NotInstalled" },
      logsShown: "NoLogsFolderSeen",
      tokenRead: "NoControllerSaved",
      picked: { _tag: "Cancelled" },
    });
    expect(window.calls).toEqual(["pickFolder"]);
  });
});
