/**
 * The check of the user timezone setting. Two operations write the setting,
 * `settings.update` and `setup.complete`, and both run this check first.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { createValidationError, quoteAuthorText, type Validation } from "@hercule/contract";

/**
 * Checks that `timezone` is an IANA zone name that this runtime knows, such as
 * `Europe/Amsterdam`. Fails with a `Validation` error at `path` otherwise.
 *
 * The contract bounds only the length, because each runtime knows its own
 * list of zones. The check is here because the Scheduler reads every cron
 * schedule that sets no timezone of its own in this setting: a name the
 * runtime does not know would make every such schedule fail to parse. It is
 * the same check a workflow save runs on a trigger's timezone.
 */
export const validateTimezone = (
  timezone: string,
  path: ReadonlyArray<string>,
): Effect.Effect<void, Validation> =>
  Option.isSome(DateTime.zoneMakeNamed(timezone))
    ? Effect.void
    : Effect.fail(
        createValidationError([
          {
            path,
            message: `${quoteAuthorText(timezone)} is not a timezone. Write an IANA timezone, such as Europe/Amsterdam.`,
          },
        ]),
      );
