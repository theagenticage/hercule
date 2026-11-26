/**
 * Owns what the `agy` conversation holds as its model and thinking level, and
 * changes them. A session changes them in two places, at its start and before an
 * input, and both need the same calls, deadline and judgement; they differ only
 * in how they report a failure, so each maps the outcome to its own error.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AcpError } from "@hercule/acp";
import type { AcpConnection, SessionSettings } from "@hercule/acp";
import type { ModelSelection } from "@hercule/protocol";
import { formatModelArgument } from "../account";
import { ANTIGRAVITY_NAME } from "./agy";
import { findSelectOption } from "./model-catalog";

export type ConfigOptions = SessionSettings["configOptions"];

/**
 * How long one call that changes the model, level or mode may take. ACP's own
 * limit is 30 seconds, which is longer than the controller waits for an input
 * (`SESSION_INPUT_DEADLINE`, 10 seconds).
 */
export const CONFIG_DEADLINE = Duration.seconds(3);

/** What `agy` holds as the model and the thinking level. A field that is undefined is not known. */
export interface HeldSelection {
  /** The model as `agy` names it: the account's model argument applied to the model id. */
  readonly model: string | undefined;
  readonly effort: string | undefined;
}

/** The setting to change: which one, the value to ask for, and how the user knows it. */
export interface SettingChange {
  readonly configId: "model" | "thought_level";
  /** The value `agy` takes: the account's model argument, or the level. */
  readonly value: string;
  readonly kind: "model" | "level";
  /** The model or level as the user named it, for messages. */
  readonly display: string;
}

/**
 * How `apply` ended, and what `agy` holds afterwards (`held`).
 *
 * - `applied`: `agy` confirmed every change the selection needed.
 * - `cancelled`: the caller gave up after the model, so the level was not asked for.
 * - `failed`: the call for `change` was refused, did not answer in time, or
 *   the connection closed (`error.reason` says which).
 * - `other`: the reply to `change` names another value, `named`.
 * - `unconfirmed`: the reply to `change` names no value, so it is not known whether it took.
 */
export type ApplyOutcome =
  | { readonly kind: "applied"; readonly held: HeldSelection }
  | { readonly kind: "cancelled"; readonly held: HeldSelection }
  | {
      readonly kind: "failed";
      readonly change: SettingChange;
      readonly error: AcpError;
      readonly held: HeldSelection;
    }
  | {
      readonly kind: "other";
      readonly change: SettingChange;
      readonly named: string;
      readonly held: HeldSelection;
    }
  | { readonly kind: "unconfirmed"; readonly change: SettingChange; readonly held: HeldSelection };

/** An ending of `apply` that is not `applied` or `cancelled`: one change went wrong. */
export type ApplyFailure = Exclude<ApplyOutcome, { readonly kind: "applied" | "cancelled" }>;

/** The model and level of a conversation, as the session changes them. */
export interface ConfigChange {
  /**
   * Makes `agy` hold the model and level of `selection`, asking only for what it
   * does not hold: the model first, then the level. A model that was confirmed
   * stays recorded when its level fails or the call is cancelled.
   * `isCancelled` is checked after the model, and the level is not asked for
   * when it says true. What `agy` holds is unknown while a call is in flight and
   * after one that was not confirmed, so the next `apply` asks again; a refusal
   * puts back what was held before. Never fails: every ending is an outcome.
   */
  readonly apply: (
    selection: ModelSelection,
    isCancelled: () => boolean,
  ) => Effect.Effect<ApplyOutcome>;
  /**
   * Takes in the options of an update `agy` sent by itself. An update that names
   * another model or level than the one held makes what is held unknown. An
   * update proves no change that was asked for: it can lag behind, and only the
   * reply to a request confirms.
   */
  readonly observe: (options: ConfigOptions) => void;
}

/** Returns the effort level the selection asks for, or undefined when it asks for none. */
const readEffort = (selection: ModelSelection): string | undefined => {
  const effort = selection.options["effort"];
  return typeof effort === "string" && effort !== "" ? effort : undefined;
};

/** Returns what a `select` option of `options` currently has, or undefined when there is no such option. */
const readHeld = (options: ConfigOptions, id: string): string | undefined =>
  findSelectOption(options, id)?.currentValue;

/** Returns what the change is called in a message, such as "the model gemini-4". */
export const describeSetting = (change: SettingChange): string =>
  `the ${change.kind} ${change.display}`;

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
 * Returns the model and level of the conversation `nativeSessionId`, which
 * holds what `initialOptions` (from the reply that opened it) say.
 * `modelArgument` is the account's model argument. `onReplyOptions` receives the
 * options of every reply to a change, because a mode `agy` reports only there
 * must still reach the session's mode tracking.
 */
export const createConfigChange = (
  connection: Pick<AcpConnection, "setConfigOption">,
  nativeSessionId: string,
  modelArgument: string,
  initialOptions: ConfigOptions,
  onReplyOptions: (options: ConfigOptions) => void,
): ConfigChange => {
  let held: HeldSelection = {
    model: readHeld(initialOptions, "model"),
    effort: readHeld(initialOptions, "thought_level"),
  };

  /**
   * Asks for one setting and returns what the reply says, or undefined when it
   * confirms. Only the reply counts, and a reply that names no value is
   * `unconfirmed`, never taken as the requested one. `recordNamed` is what
   * `agy` holds when the reply names another value.
   */
  const change = (
    setting: SettingChange,
    heldWhileChanging: HeldSelection,
    recordConfirmed: (options: ConfigOptions) => HeldSelection,
    recordNamed: (named: string, options: ConfigOptions) => HeldSelection,
  ): Effect.Effect<ApplyFailure | undefined> => {
    const before = held;
    held = heldWhileChanging;
    return withDeadline(
      connection.setConfigOption(nativeSessionId, setting.configId, setting.value),
      CONFIG_DEADLINE,
      `switch to ${describeSetting(setting)}`,
    ).pipe(
      Effect.map((options) => {
        onReplyOptions(options);
        const named = readHeld(options, setting.configId);
        if (named === setting.value) {
          held = recordConfirmed(options);
          return undefined;
        }
        if (named === undefined) return { kind: "unconfirmed" as const, change: setting, held };
        held = recordNamed(named, options);
        return { kind: "other" as const, change: setting, named, held };
      }),
      Effect.catch((error: AcpError) => {
        // A refusal means the setting did not change; anything else leaves it unknown.
        if (error.reason === "refused") held = before;
        return Effect.succeed({ kind: "failed" as const, change: setting, error, held });
      }),
    );
  };

  const apply: ConfigChange["apply"] = (selection, isCancelled) =>
    Effect.gen(function* () {
      const model = formatModelArgument(modelArgument, selection.model);
      const effort = readEffort(selection);
      if (held.model !== model) {
        const failure = yield* change(
          { configId: "model", value: model, kind: "model", display: selection.model },
          { model: undefined, effort: undefined },
          (options) => ({ model, effort: readHeld(options, "thought_level") }),
          (named, options) => ({ model: named, effort: readHeld(options, "thought_level") }),
        );
        if (failure !== undefined) return failure;
      }
      if (isCancelled()) return { kind: "cancelled", held } as const;
      if (effort !== undefined && held.effort !== effort) {
        const heldModel = held.model;
        const failure = yield* change(
          { configId: "thought_level", value: effort, kind: "level", display: effort },
          { model: heldModel, effort: undefined },
          () => ({ model: heldModel, effort }),
          (named) => ({ model: heldModel, effort: named }),
        );
        if (failure !== undefined) return failure;
      }
      return { kind: "applied", held } as const;
    });

  const observe: ConfigChange["observe"] = (options) => {
    const model = readHeld(options, "model");
    const effort = readHeld(options, "thought_level");
    if (
      (held.model !== undefined && model !== undefined && model !== held.model) ||
      (held.effort !== undefined && effort !== undefined && effort !== held.effort)
    ) {
      held = { model: undefined, effort: undefined };
    }
  };

  return { apply, observe };
};
