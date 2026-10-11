/**
 * Works out which Intake settings are in effect. A setting is one switch per
 * kind: "available to triage" for an event kind, "on" for a signal kind. It
 * can be set at three levels, and each level stores only the kinds where it
 * differs from the level below:
 *
 * 1. the default the plugin declares in code;
 * 2. the user's choice for the plugin;
 * 3. the user's choice for one Connection.
 *
 * This module is pure. It reads no database and no plugin, so the plugins
 * domain, the connections domain and the controller daemon can all use it.
 */
import * as Effect from "effect/Effect";
import {
  createValidationError,
  type IntakeOverrideLevel,
  type IntakeOverrides,
  type IntakeSettings,
  type Validation,
} from "@hercule/contract";

/** The overrides of a level where the user chose nothing. */
export const NO_INTAKE_OVERRIDES: IntakeOverrides = { eventKinds: {}, signalKinds: {} };

/**
 * Returns `settings` with the user's choices of one level on top. A kind with
 * an entry takes the entry's value and `level`, even when that equals the
 * value below. A kind without an entry keeps what it had. An entry for a kind
 * that is not in `settings`, such as one a plugin update removed, is ignored.
 */
export const applyIntakeOverrides = (
  settings: IntakeSettings,
  overrides: IntakeOverrides,
  level: IntakeOverrideLevel,
): IntakeSettings => ({
  eventKinds: settings.eventKinds.map((setting) =>
    Object.hasOwn(overrides.eventKinds, setting.kind)
      ? { ...setting, on: overrides.eventKinds[setting.kind]!, level }
      : setting,
  ),
  signalKinds: settings.signalKinds.map((setting) =>
    Object.hasOwn(overrides.signalKinds, setting.kind)
      ? { ...setting, on: overrides.signalKinds[setting.kind]!, level }
      : setting,
  ),
});

/** Describes the kinds a write can choose from, for the message that refuses another. */
const describeChoices = (what: string, kinds: ReadonlyArray<{ readonly kind: string }>): string =>
  kinds.length === 0
    ? `The plugin declares no ${what}, so there is nothing to choose.`
    : `Choose ${what} from ${kinds.map(({ kind }) => kind).join(", ")}.`;

/**
 * Returns the entries of `choices` whose value differs from the value
 * `settings` gives for the same kind.
 */
const keepDifferingChoices = (
  choices: Readonly<Record<string, boolean>>,
  settings: ReadonlyArray<{ readonly kind: string; readonly on: boolean }>,
): Record<string, boolean> =>
  Object.fromEntries(
    Object.entries(choices).filter(
      ([kind, on]) => settings.find((setting) => setting.kind === kind)?.on !== on,
    ),
  );

/**
 * Checks one level's write against the value the level below gives, and
 * returns the entries to store: every entry whose value equals what `below`
 * already gives is dropped, so that kind follows the level below again.
 *
 * Fails with `validation`, with one issue per refused kind at
 * `intake.eventKinds.<kind>` or `intake.signalKinds.<kind>`, when the write
 * names a kind that `below` does not list, which means the plugin does not
 * declare it. The top-level message names the refused kinds and lists the
 * kinds to choose from once. Nothing is stored in that case.
 */
export const normalizeIntakeOverrides = (
  written: IntakeOverrides,
  below: IntakeSettings,
): Effect.Effect<IntakeOverrides, Validation> =>
  Effect.gen(function* () {
    const refusedEventKinds = Object.keys(written.eventKinds).filter(
      (kind) => !below.eventKinds.some((setting) => setting.kind === kind),
    );
    const refusedSignalKinds = Object.keys(written.signalKinds).filter(
      (kind) => !below.signalKinds.some((setting) => setting.kind === kind),
    );
    if (refusedEventKinds.length > 0 || refusedSignalKinds.length > 0) {
      const issues = [
        ...refusedEventKinds.map((kind) => ({
          path: ["intake", "eventKinds", kind],
          message: `${kind} is not an event kind of this plugin.`,
        })),
        ...refusedSignalKinds.map((kind) => ({
          path: ["intake", "signalKinds", kind],
          message: `${kind} is not a signal kind of this plugin.`,
        })),
      ];
      // The top-level message is the line the CLI prints, so it lists the
      // choices once instead of repeating them in every issue.
      const message = [
        `The plugin does not declare ${[...refusedEventKinds, ...refusedSignalKinds].join(", ")}.`,
        ...(refusedEventKinds.length > 0 ? [describeChoices("event kinds", below.eventKinds)] : []),
        ...(refusedSignalKinds.length > 0
          ? [describeChoices("signal kinds", below.signalKinds)]
          : []),
      ].join(" ");
      return yield* Effect.fail(createValidationError(issues, message));
    }
    return {
      eventKinds: keepDifferingChoices(written.eventKinds, below.eventKinds),
      signalKinds: keepDifferingChoices(written.signalKinds, below.signalKinds),
    };
  });

/**
 * Builds the error that refuses an Intake write for a plugin that did not
 * load. Such a plugin registered no event source, so its kinds are unknown
 * and any choice would look like an unknown kind.
 */
export const createPluginNotLoadedError = (pluginId: string): Validation => {
  const message =
    `The plugin ${pluginId} failed to load, so its Intake settings cannot be changed. ` +
    "Fix the failure its status reports and restart the controller.";
  return createValidationError([{ path: [], message }], message);
};
