/**
 * Builds what Settings > System shows about text generation: the choices for
 * the `textGeneration.model` setting, and the line about the last failure.
 * The web app and the desktop app both read them from here, so neither screen
 * holds a rule of its own about what Automatic means or when a failure is
 * worth showing. The desktop's first run names the model with
 * `describeTextGenerationModel`.
 *
 * The controller decides which model Automatic resolves to and reports it in
 * `controller.read`. Nothing here repeats that rule.
 */
import type {
  ProviderInstance,
  TextGenerationModel,
  TextGenerationStatus,
} from "@hercule/contract";
import { describeAge } from "./threads/age";
import { describeAgent } from "./threads/model-name";

/** One entry of the model select: what the user reads, and the setting picking it stores. */
export interface TextGenerationChoice {
  /** A unique string for the select to hold; not a setting value. */
  readonly key: string;
  readonly label: string;
  readonly setting: TextGenerationModel;
}

/** The model select: its entries, and the key of the entry the stored setting selects. */
export interface TextGenerationField {
  readonly choices: readonly TextGenerationChoice[];
  readonly selectedKey: string;
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

const buildModelKey = (instanceId: string, model: string): string => `${instanceId}/${model}`;

/**
 * Returns the model select: Automatic first, then one entry per provider
 * instance and model that is logged in on some runner, then Off. A model that
 * a harness keeps only for old sessions (`isLegacy`) is not offered, and a
 * model several runners list appears once.
 *
 * Automatic names the model it resolves to only while it is the stored
 * setting. With any other setting, `status.model` is that setting's own model,
 * so it says nothing about what Automatic would pick.
 *
 * A stored model that no logged-in instance offers any more (the instance was
 * deleted, or logged out) stays in the list as "(not offered)". The setting
 * is the user's choice and does not silently change; the controller reports
 * the failures it causes.
 */
export const buildTextGenerationField = (
  stored: TextGenerationModel | undefined,
  instances: readonly ProviderInstance[],
  status: TextGenerationStatus,
): TextGenerationField => {
  const setting = stored ?? "automatic";

  const describeAutomatic = (): string => {
    if (setting !== "automatic") return "Automatic";
    if (status.model === null) return "Automatic - no model available";
    return `Automatic - currently ${describeTextGenerationModel(instances, status.model)}`;
  };

  const offered: TextGenerationChoice[] = instances.flatMap((instance) => {
    const slugs = new Set(
      instance.snapshots
        .filter((snapshot) => snapshot.auth.status === "ok")
        .flatMap((snapshot) => snapshot.models)
        .filter((model) => model.isLegacy !== true)
        .map((model) => model.slug),
    );
    return [...slugs].map((slug) => ({
      key: buildModelKey(instance.id, slug),
      label: describeAgent(instance, slug),
      setting: { instanceId: instance.id, model: slug },
    }));
  });

  const selectedKey =
    typeof setting === "string" ? setting : buildModelKey(setting.instanceId, setting.model);

  if (typeof setting === "object" && !offered.some((choice) => choice.key === selectedKey)) {
    offered.push({
      key: selectedKey,
      label: `${describeTextGenerationModel(instances, setting)} (not offered)`,
      setting,
    });
  }

  return {
    choices: [
      { key: "automatic", label: describeAutomatic(), setting: "automatic" },
      ...offered,
      { key: "off", label: "Off", setting: "off" },
    ],
    selectedKey,
  };
};

const FAILURE_REASON_WORDS = {
  unavailable: "no model available",
  timeout: "timed out",
  "invalid-output": "invalid output",
} as const;

/**
 * Returns the line about the last failed text generation, such as
 * "Last failure 5 minutes ago - timed out: The model did not answer in time."
 * Returns null when there is nothing to show: no failure is known, or text
 * generation is off, because a failure from before it was turned off no
 * longer says anything about the current setting.
 */
export const describeTextGenerationFailure = (
  stored: TextGenerationModel | undefined,
  status: TextGenerationStatus,
  now: Date,
): string | null => {
  if (stored === "off" || status.lastFailure === null) return null;
  const { reason, message, at } = status.lastFailure;
  return `Last failure ${describeAge(at, now)} - ${FAILURE_REASON_WORDS[reason]}: ${message}`;
};
