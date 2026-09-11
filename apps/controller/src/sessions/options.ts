/**
 * What makes a per-model pick wrong. Pure: the catalog is read by the caller
 * and handed in, so this is the one place that holds the rules.
 */
import * as Effect from "effect/Effect";
import type { ModelDescriptor, ModelSelection } from "@hydra/protocol";
import { validation, type Validation } from "@hydra/contract";

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
