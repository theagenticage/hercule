/**
 * What Settings > System shows of text generation: the choices of the
 * "Text generation" select, and the line about the last failure. The first
 * run's All set names the model with `describeTextGenerationModel`.
 *
 * The controller decides which model Automatic resolves to and reports it in
 * `controller.read`. Nothing here repeats that rule.
 */
import type {
  ProviderInstance,
  TextGenerationFailureReason,
  TextGenerationModel,
  TextGenerationStatus,
} from "@hercule/contract";
import { describeAge } from "./threads/age";
import { describeAgent } from "./threads/model-name";

/** One entry of the "Text generation" select. */
export interface TextGenerationChoice {
  /** The option's value: a string that identifies `setting` in the select. */
  readonly key: string;
  readonly label: string;
  /** What choosing the entry stores in the `textGeneration.model` setting. */
  readonly setting: TextGenerationModel;
}

/** A model that text generation runs on: the instance and the model's slug. */
type ResolvedModel = NonNullable<TextGenerationStatus["model"]>;

/**
 * Returns the name of the model text generation runs on, such as
 * `Codex · GPT-6 Luna`. Falls back to the slug alone when the instance is
 * gone, as `describeAgent` does.
 */
export const describeTextGenerationModel = (
  instances: readonly ProviderInstance[],
  model: ResolvedModel,
): string =>
  describeAgent(
    instances.find((instance) => instance.id === model.instanceId),
    model.model,
  );

/**
 * Returns the string that identifies a stored `setting` as an option value:
 * `automatic`, `off`, or the instance id and the model joined by a space. An
 * instance id holds no space, so the join is unambiguous.
 */
export const findTextGenerationChoiceKey = (setting: TextGenerationModel): string =>
  typeof setting === "string" ? setting : `${setting.instanceId} ${setting.model}`;

/**
 * Returns the entries of the "Text generation" select, in this order:
 *
 * - Automatic, which names the model it resolves to now (`resolved`), or says
 *   that none is available;
 * - one entry per model of each instance that is logged in on some runner;
 * - the `current` setting, when it names a model not listed above, such as
 *   one whose instance has since logged out, so the select still shows what
 *   is stored;
 * - Off.
 *
 * A model that a harness keeps only for old sessions (`isLegacy`) is not
 * offered, and a model several runners list appears once.
 */
export const listTextGenerationChoices = (
  instances: readonly ProviderInstance[],
  current: TextGenerationModel,
  resolved: TextGenerationStatus["model"],
): readonly TextGenerationChoice[] => {
  const automatic: TextGenerationChoice = {
    key: "automatic",
    label:
      resolved === null
        ? "Automatic - no model available"
        : `Automatic - currently ${describeTextGenerationModel(instances, resolved)}`,
    setting: "automatic",
  };
  const models = new Map<string, TextGenerationChoice>();
  for (const instance of instances) {
    for (const snapshot of instance.snapshots) {
      if (snapshot.auth.status !== "ok") continue;
      for (const model of snapshot.models) {
        if (model.isLegacy === true) continue;
        const setting = { instanceId: instance.id, model: model.slug };
        const key = findTextGenerationChoiceKey(setting);
        if (!models.has(key)) {
          models.set(key, { key, label: describeTextGenerationModel(instances, setting), setting });
        }
      }
    }
  }
  const currentKey = findTextGenerationChoiceKey(current);
  const kept: readonly TextGenerationChoice[] =
    typeof current === "string" || models.has(currentKey)
      ? []
      : [
          {
            key: currentKey,
            label: describeTextGenerationModel(instances, current),
            setting: current,
          },
        ];
  return [automatic, ...models.values(), ...kept, { key: "off", label: "Off", setting: "off" }];
};

const FAILURE_REASON_WORDS: Readonly<Record<TextGenerationFailureReason, string>> = {
  unavailable: "no model could take it",
  timeout: "timed out",
  "invalid-output": "the model's answer was not usable",
};

/**
 * Returns the line about the last failed text generation, such as
 * `Last failure 3 minutes ago, timed out: <the controller's message>`. `now`
 * is a parameter so that the caller decides what "now" is.
 */
export const describeTextGenerationFailure = (
  failure: NonNullable<TextGenerationStatus["lastFailure"]>,
  now: Date,
): string =>
  `Last failure ${describeAge(failure.at, now)}, ${FAILURE_REASON_WORDS[failure.reason]}: ${failure.message}`;
