/**
 * What a session starts under, as far as it is a matter of shaping values: what
 * makes a per-model pick wrong, the two clocks it runs under, and the document
 * a session picking up another's transcript is told. Pure throughout - the
 * catalog, the settings and the row are read by the caller and handed in, so
 * this is the one place that holds the rules.
 */
import * as Effect from "effect/Effect";
import type { ModelDescriptor, ModelSelection, SessionSpec } from "@hydra/protocol";
import { validation, type Validation } from "@hydra/contract";
import type { ScopeSettings } from "../settings";

/** The picks themselves, in the shape the row and the wire hold them. */
export type ModelOptions = ModelSelection["options"];

/**
 * Passes where every pick is one the model offers, and fails with a
 * `validation` naming each one that is not. Every wrong pick is reported, not
 * just the first, so a caller fixing a form sees all of it at once.
 *
 * A model the catalog has no descriptor for offers nothing, so every pick sent
 * with it is refused - which is how a slug nobody recognises is caught here,
 * even though the slug itself is left to the machine to refuse.
 */
export const validatedOptions = (
  models: ReadonlyArray<ModelDescriptor>,
  model: string,
  given: ModelOptions,
): Effect.Effect<void, Validation> => {
  const described = models.find((one) => one.slug === model);
  const issues = Object.entries(given).flatMap(([id, value]) => {
    const at = { path: ["options", id] };
    if (described === undefined) {
      return [{ ...at, message: `the machine reported no descriptor for ${model}` }];
    }
    const option = described.options.find((one) => one.id === id);
    if (option === undefined) return [{ ...at, message: `${model} offers no ${id}` }];
    if (option.kind === "boolean") {
      return typeof value === "boolean"
        ? []
        : [{ ...at, message: `${id} is a switch: true or false` }];
    }
    const choices = (option.choices ?? []).map((choice) => choice.value);
    return typeof value === "string" && choices.includes(value)
      ? []
      : [{ ...at, message: `${id} takes one of ${choices.join(", ")}` }];
  });
  return issues.length === 0 ? Effect.void : Effect.fail(validation(issues));
};

/** Applied here, controller-side, when the settings key is unset; the runner holds no default of its own. */
const DEFAULT_INACTIVITY_TIMEOUT_MINUTES = 30;

const DEFAULT_ABSOLUTE_TIMEOUT_MINUTES = 480;

const MINUTE_MS = 60_000;

/** The two clocks a session starts under, whole minutes turned into the milliseconds the wire carries. */
export const timeoutsFrom = (controller: ScopeSettings<"controller">): SessionSpec["timeouts"] => ({
  inactivityMs:
    (controller["session.inactivityTimeoutMinutes"] ?? DEFAULT_INACTIVITY_TIMEOUT_MINUTES) *
    MINUTE_MS,
  absoluteMs:
    (controller["session.absoluteTimeoutMinutes"] ?? DEFAULT_ABSOLUTE_TIMEOUT_MINUTES) * MINUTE_MS,
});

/**
 * Builds the document a machine is told for a session that picks up a
 * provider-native session, either resumed in place or forked off. It is the
 * document the parent was told, with the selection the parent ended on, the
 * native session it carries on from, and the timeouts as they stand now.
 *
 * It starts from the parent's own document and not from named fields, so
 * everything an Agent gave the parent reaches the continuation: the prompt,
 * the tools the session may not use, and the schema it answers under. Copying
 * is the rule here (ADR 0030). A fork that ran under a different prompt than
 * the session it came from would be a different piece of work.
 */
export const buildContinuingSpec = (
  parent: SessionSpec,
  controller: ScopeSettings<"controller">,
  modelSelection: ModelSelection,
  nativeSessionId: string,
  mode: NonNullable<SessionSpec["continue"]>["mode"],
): SessionSpec => ({
  ...parent,
  modelSelection,
  continue: { nativeSessionId, mode },
  timeouts: timeoutsFrom(controller),
});
