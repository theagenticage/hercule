/**
 * Re-pointing this machine at a controller that moved.
 *
 * It runs here rather than as an operation because a controller cannot tell a
 * runner where to look for it: the machine is holding an address that no longer
 * answers. Nothing is asked of the new address either, so a controller that is
 * not up yet does not block the re-point.
 *
 * The credential, the runner's id and the pinned key are left alone. A
 * controller is a logical identity, and the hello check is what refuses one
 * that is not this runner's.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readRunnerFile, runnerFileIn, writeRunnerFile } from "./runner-file";

export class SetControllerError extends Schema.TaggedError<SetControllerError>()(
  "SetControllerError",
  { message: Schema.String },
) {}

/** The two schemes the runner socket knows how to dial. */
const SCHEMES = ["http:", "https:"];

export const setController = (options: {
  readonly home: string;
  /** As the user typed it. */
  readonly controllerUrl: string;
}): Effect.Effect<string, SetControllerError> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(options.controllerUrl),
      catch: () =>
        new SetControllerError({
          message: `${options.controllerUrl} is not a controller URL`,
        }),
    });
    if (!SCHEMES.includes(url.protocol)) {
      return yield* Effect.fail(
        new SetControllerError({
          message: `${options.controllerUrl} is not a controller URL: it must be http or https`,
        }),
      );
    }
    const current = yield* Effect.mapError(
      readRunnerFile(options.home),
      (error) => new SetControllerError({ message: error.message }),
    );
    const path = runnerFileIn(options.home);
    yield* Effect.try({
      try: () => {
        writeRunnerFile(path, { ...current, controllerUrl: options.controllerUrl });
      },
      catch: (cause) =>
        new SetControllerError({ message: `cannot write ${path}: ${String(cause)}` }),
    });
    return options.controllerUrl;
  });
