/**
 * The setup token of the saved controller, which the first run needs to
 * create the user's account on a controller that is not set up yet.
 */
import * as Effect from "effect/Effect";
import type { SetupTokenReadOutcome } from "../ipc/contract";
import { AppSettings, NoControllerSaved } from "./app-settings";
import { ControllerConnection, parseControllerAddress } from "./controller-connection";
import { InstalledBinary } from "./installed-binary";

/**
 * Returns the setup token of the saved controller, from the first of:
 *
 * - the setup address the user pasted for it, returned once;
 * - `hercule setup-url` on this Mac, when the address it prints is the saved
 *   controller's.
 *
 * Returns `PasteNeeded` when neither has one, such as for a controller on
 * another machine. A binary that fails is logged as a warning and counts as
 * none. Fails with NoControllerSaved when no controller URL is saved.
 */
export const readSetupToken: Effect.Effect<
  SetupTokenReadOutcome,
  NoControllerSaved,
  AppSettings | ControllerConnection | InstalledBinary
> = Effect.gen(function* () {
  const controllerUrl = yield* AppSettings.use((settings) => settings.readControllerUrl);
  if (controllerUrl === null) return yield* new NoControllerSaved("a setup token");
  const pasted = yield* ControllerConnection.use((connection) =>
    connection.takePastedSetupToken(controllerUrl),
  );
  if (pasted !== null) return { _tag: "Token", token: pasted } as const;

  const setupUrl = yield* InstalledBinary.use((binary) => binary.readSetupUrl).pipe(
    Effect.catchTag("BinaryNotFound", () => Effect.succeed(null)),
    Effect.catchTag("BinaryCommandFailed", (error) =>
      Effect.as(Effect.logWarning(`Could not read the setup URL: ${error.line}`), null),
    ),
  );
  const address = setupUrl === null ? null : parseControllerAddress(setupUrl);
  return address?.origin === controllerUrl && address.setupToken !== null
    ? ({ _tag: "Token", token: address.setupToken } as const)
    : ({ _tag: "PasteNeeded" } as const);
});
