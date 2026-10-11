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
  type IntakeOverrides,
  type IntakeSettingLevel,
  type IntakeSettings,
  type Validation,
} from "@hercule/contract";

/** One event kind as its plugin declares it. */
export interface DeclaredEventKindIntake {
  readonly kind: string;
  readonly description: string;
  /** The default of the kind's switch: whether triage may read its events. */
  readonly availableToTriage: boolean;
}

/** One signal kind as its plugin declares it. A signal kind declares no default: it starts on. */
export interface DeclaredSignalKindIntake {
  /** The qualified kind, such as `github/review-requested`. */
  readonly kind: string;
  readonly label: string;
  readonly description: string;
}

/** Every kind one plugin declares, in the order it declares them. */
export interface DeclaredIntakeKinds {
  readonly eventKinds: ReadonlyArray<DeclaredEventKindIntake>;
  readonly signalKinds: ReadonlyArray<DeclaredSignalKindIntake>;
}

/** The overrides of a level where the user chose nothing. */
export const NO_INTAKE_OVERRIDES: IntakeOverrides = { eventKinds: {}, signalKinds: {} };

/**
 * Returns the settings a plugin gives before the user chooses anything: each
 * event kind is as available to triage as the plugin declared it, and every
 * signal kind is on.
 */
export const buildDefaultIntakeSettings = (declared: DeclaredIntakeKinds): IntakeSettings => ({
  eventKinds: declared.eventKinds.map(({ kind, description, availableToTriage }) => ({
    kind,
    description,
    on: availableToTriage,
    level: "default",
  })),
  signalKinds: declared.signalKinds.map(({ kind, label, description }) => ({
    kind,
    label,
    description,
    on: true,
    level: "default",
  })),
});

/**
 * Returns `settings` with the user's choices of one level on top. A kind with
 * an entry takes the entry's value and `level`, even when that equals the
 * value below. A kind without an entry keeps what it had. An entry for a kind
 * that is not in `settings`, such as one a plugin update removed, is ignored.
 */
export const applyIntakeOverrides = (
  settings: IntakeSettings,
  overrides: IntakeOverrides,
  level: Exclude<IntakeSettingLevel, "default">,
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
    : `Choose from ${kinds.map(({ kind }) => kind).join(", ")}.`;

/**
 * Checks one level's write against the value the level below gives, and
 * returns the entries to store: every entry whose value equals what `below`
 * already gives is dropped, so that kind follows the level below again.
 *
 * Fails with `validation`, with one issue per refused kind at
 * `intake.eventKinds.<kind>` or `intake.signalKinds.<kind>`, when the write
 * names a kind that `below` does not list, which means the plugin does not
 * declare it. Nothing is stored in that case.
 */
export const normalizeIntakeOverrides = (
  written: IntakeOverrides,
  below: IntakeSettings,
): Effect.Effect<IntakeOverrides, Validation> =>
  Effect.gen(function* () {
    const issues = [
      ...Object.keys(written.eventKinds)
        .filter((kind) => !below.eventKinds.some((setting) => setting.kind === kind))
        .map((kind) => ({
          path: ["intake", "eventKinds", kind],
          message: `${kind} is not an event kind of this plugin. ${describeChoices("event kinds", below.eventKinds)}`,
        })),
      ...Object.keys(written.signalKinds)
        .filter((kind) => !below.signalKinds.some((setting) => setting.kind === kind))
        .map((kind) => ({
          path: ["intake", "signalKinds", kind],
          message: `${kind} is not a signal kind of this plugin. ${describeChoices("signal kinds", below.signalKinds)}`,
        })),
    ];
    // Every message is also in the top-level message, which is the line the
    // CLI prints.
    if (issues.length > 0) {
      const message = issues.map((issue) => issue.message).join(" ");
      return yield* Effect.fail(createValidationError(issues, message));
    }
    const differing = (
      choices: Readonly<Record<string, boolean>>,
      settings: ReadonlyArray<{ readonly kind: string; readonly on: boolean }>,
    ): Record<string, boolean> =>
      Object.fromEntries(
        Object.entries(choices).filter(
          ([kind, on]) => settings.find((setting) => setting.kind === kind)?.on !== on,
        ),
      );
    return {
      eventKinds: differing(written.eventKinds, below.eventKinds),
      signalKinds: differing(written.signalKinds, below.signalKinds),
    };
  });
