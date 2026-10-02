import { beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { NoControllerSaved } from "./app-settings";
import { ControllerConnection } from "./controller-connection";
import { BinaryCommandFailed, BinaryNotFound, InstalledBinary } from "./installed-binary";
import { readSetupToken } from "./setup-token";
import { makeTemporarySettingsFile, type TemporarySettingsFile } from "./testing";

const ORIGIN = "http://127.0.0.1:4937";

let settingsFile: TemporarySettingsFile;
/** The token the user pasted for the saved controller, or null. */
let pastedToken: string | null;
/** What `hercule setup-url` returns. */
let setupUrl: Effect.Effect<string | null, BinaryNotFound | BinaryCommandFailed>;

beforeEach(() => {
  settingsFile = makeTemporarySettingsFile();
  writeFileSync(settingsFile.path, JSON.stringify({ controllerUrl: ORIGIN }));
  pastedToken = null;
  setupUrl = Effect.succeed(null);
  return settingsFile.remove;
});

/** Reads the setup token with the temporary settings file and the fakes. */
const read = () =>
  Effect.runPromise(
    readSetupToken.pipe(
      Effect.match({ onSuccess: (outcome) => outcome, onFailure: (error) => error }),
      Effect.provide(
        Layer.mergeAll(
          settingsFile.layer,
          Layer.succeed(ControllerConnection)({
            save: () => Effect.die("not used"),
            check: () => Effect.die("not used"),
            saveAndReload: () => Effect.die("not used"),
            takePastedSetupToken: (origin) =>
              Effect.sync(() => (origin === ORIGIN ? pastedToken : null)),
          }),
          Layer.succeed(InstalledBinary)({
            readStatus: Effect.die("not used"),
            install: () => Effect.die("not used"),
            readSetupUrl: Effect.suspend(() => setupUrl),
          }),
        ),
      ),
    ),
  );

describe("readSetupToken", () => {
  it("returns the token the user pasted first", async () => {
    pastedToken = "pasted";
    setupUrl = Effect.succeed(`${ORIGIN}/setup?token=printed`);
    expect(await read()).toEqual({ _tag: "Token", token: "pasted" });
  });

  it("returns the token `hercule setup-url` prints for the saved controller", async () => {
    setupUrl = Effect.succeed(`${ORIGIN}/setup?token=printed`);
    expect(await read()).toEqual({ _tag: "Token", token: "printed" });
  });

  it.each([
    ["names another controller", Effect.succeed("http://127.0.0.1:5000/setup?token=printed")],
    ["prints no setup URL", Effect.succeed(null)],
    ["prints something else", Effect.succeed("not a URL")],
    ["is not installed", Effect.fail(new BinaryNotFound({ message: "none" }))],
    ["fails", Effect.fail(new BinaryCommandFailed({ line: "broken" }))],
  ])("returns PasteNeeded when the binary %s", async (_case, answer) => {
    setupUrl = answer;
    expect(await read()).toEqual({ _tag: "PasteNeeded" });
  });

  it("is refused when no controller URL is saved", async () => {
    writeFileSync(settingsFile.path, "{}");
    expect(await read()).toEqual(new NoControllerSaved("a setup token"));
  });
});
