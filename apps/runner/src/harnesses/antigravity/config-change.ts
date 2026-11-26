/**
 * Changes one setting of the `agy` conversation (its model or its thinking
 * level) and judges the reply. A session changes settings in two places, at its
 * start and before an input, and both need the same call, deadline and
 * judgement; they differ only in how they report a failure.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AcpError } from "@hercule/acp";
import type { AcpConnection, SessionSettings } from "@hercule/acp";
import type { ModelSelection } from "@hercule/protocol";
import { ANTIGRAVITY_NAME } from "./agy";

export type ConfigOptions = SessionSettings["configOptions"];

/**
 * How long one call that changes the model, level or mode may take. ACP's own
 * limit is 30 seconds, which is longer than the controller waits for an input
 * (`SESSION_INPUT_DEADLINE`, 10 seconds).
 */
export const CONFIG_DEADLINE = Duration.seconds(3);

/** What a reply to a change of a setting says about the setting. */
export type ChangeOutcome =
  | { readonly kind: "confirmed" }
  | { readonly kind: "other"; readonly named: string }
  | { readonly kind: "unconfirmed" };

/** The setting to change: which one, the value to ask for, and how the user knows it. */
export interface SettingChange {
  readonly configId: "model" | "thought_level";
  /** The value `agy` takes: the account's model argument, or the level. */
  readonly value: string;
  readonly kind: "model" | "level";
  /** The model or level as the user named it, for messages. */
  readonly display: string;
}

/** Returns what the change is called in a message, such as "the model gemini-4". */
export const describeSetting = (change: SettingChange): string =>
  `the ${change.kind} ${change.display}`;

/** Returns the value a `select` config option currently has, or undefined when there is no such option. */
export const readCurrentValue = (options: ConfigOptions, id: string): string | undefined => {
  const option = options.find((candidate) => candidate.id === id);
  return option?.type === "select" ? option.currentValue : undefined;
};

/** Returns the effort level the selection asks for, or undefined when it asks for none. */
export const readEffort = (selection: ModelSelection): string | undefined => {
  const effort = selection.options["effort"];
  return typeof effort === "string" && effort !== "" ? effort : undefined;
};

/**
 * Runs an ACP call and fails with a `timed-out` `AcpError` that says what the
 * call was for when `agy` does not answer within `deadline`.
 */
export const withDeadline = <A>(
  call: Effect.Effect<A, AcpError>,
  deadline: Duration.Duration,
  what: string,
): Effect.Effect<A, AcpError> =>
  Effect.flatMap(Effect.timeoutOption(call, deadline), (answered) =>
    Option.isSome(answered)
      ? Effect.succeed(answered.value)
      : Effect.fail(
          new AcpError({
            reason: "timed-out",
            message: `${ANTIGRAVITY_NAME} did not answer the request to ${what} in time.`,
          }),
        ),
  );

/**
 * Asks `agy` to change a setting and returns the options its reply holds, with
 * the judgement of whether the reply confirms the change. Only the reply counts:
 * a `config_option_update` notification lags behind and proves nothing, and a
 * reply that names no value is `unconfirmed`, never taken as the requested one.
 * Fails with the `AcpError` of the call, including `timed-out` after
 * `CONFIG_DEADLINE`.
 */
export const changeSetting = (
  connection: Pick<AcpConnection, "setConfigOption">,
  nativeSessionId: string,
  change: SettingChange,
): Effect.Effect<{ readonly outcome: ChangeOutcome; readonly options: ConfigOptions }, AcpError> =>
  withDeadline(
    connection.setConfigOption(nativeSessionId, change.configId, change.value),
    CONFIG_DEADLINE,
    `switch to ${describeSetting(change)}`,
  ).pipe(
    Effect.map((options) => {
      const named = readCurrentValue(options, change.configId);
      const outcome: ChangeOutcome =
        named === undefined
          ? { kind: "unconfirmed" }
          : named === change.value
            ? { kind: "confirmed" }
            : { kind: "other", named };
      return { outcome, options };
    }),
  );
