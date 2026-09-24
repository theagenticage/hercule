/**
 * Points this machine at a controller that has moved to a new URL.
 *
 * This is a local command, not an operation, because the controller cannot
 * tell a runner its new address: the runner only knows the old address, and
 * nothing responds there any more. The command does not contact the new
 * address either, so it works even when that controller is not up yet.
 *
 * The credential, the runner's id and the pinned key stay the same. A
 * controller is a logical identity, and the hello check rejects a controller
 * that is not this runner's.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CONTROLLER_URL_SCHEMES,
  readRunnerFile,
  buildRunnerFilePath,
  writeRunnerFile,
} from "./runner-file";

export class SetControllerError extends Schema.TaggedError<SetControllerError>()(
  "SetControllerError",
  { message: Schema.String },
) {}

export const setController = (options: {
  readonly home: string;
  /** The URL exactly as the user typed it. */
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
    if (!CONTROLLER_URL_SCHEMES.includes(url.protocol)) {
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
    const path = buildRunnerFilePath(options.home);
    yield* Effect.try({
      try: () => {
        writeRunnerFile(path, { ...current, controllerUrl: options.controllerUrl });
      },
      catch: (cause) =>
        new SetControllerError({ message: `cannot write ${path}: ${String(cause)}` }),
    });
    return options.controllerUrl;
  });
