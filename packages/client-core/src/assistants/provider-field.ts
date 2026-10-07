/**
 * The Provider field of Settings > Assistants: one menu that picks both the
 * provider instance an assistant runs on and the model it uses there.
 */
import type { ProviderInstance } from "@hercule/contract";
import { toIdTail } from "../id-tail";
import { buildInstanceLabel } from "../threads/catalog";
import { buildThreadModelField } from "../threads/model-field";
import type { AssistantDraft } from "./form";

/** One choice in the Provider field: an instance and a model on it. */
interface AssistantProviderChoice {
  readonly instanceId: string;
  /** The model's slug, or `null` for the instance's default model. */
  readonly model: string | null;
  /** The choice's text, such as `Claude Code · Sonnet 5`. */
  readonly label: string;
}

/** The choices of one provider instance, shown as one group of the menu. */
interface AssistantProviderGroup {
  readonly instanceId: string;
  readonly label: string;
  readonly choices: readonly AssistantProviderChoice[];
}

interface AssistantProviderField {
  readonly groups: readonly AssistantProviderGroup[];
  /** The provider of the assistant's instance, for its logo, or `null` when the instance is gone. */
  readonly providerId: string | null;
  /**
   * The account the assistant's instance is logged in as, else the instance's
   * display name, or "" when the instance is gone.
   */
  readonly hint: string;
}

/**
 * Builds the Provider field for `assistant`, the instance and model it runs
 * on, from every provider instance.
 *
 * Each instance is one group: first its default model, then each model its
 * catalog offers. The catalog is read from the instance's first snapshot,
 * because an assistant is not tied to one runner. An instance that has no
 * logged-in snapshot offers only its default model.
 *
 * A select whose value matches none of its options shows its first option
 * instead, so the assistant's own choice is always an option:
 * - a model the catalog does not offer, or that a logged-out instance cannot
 *   list, is added at the end of its instance's group;
 * - an instance that no longer exists is added as a last group, named by its
 *   id tail and "(not found)", holding only the assistant's choice.
 */
export const buildAssistantProviderField = (
  instances: readonly ProviderInstance[],
  assistant: Pick<AssistantDraft, "instanceId" | "model">,
): AssistantProviderField => {
  const buildGroup = (
    instanceId: string,
    label: string,
    slugs: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
  ): AssistantProviderGroup => {
    const models =
      instanceId === assistant.instanceId &&
      assistant.model !== null &&
      !slugs.some(({ slug }) => slug === assistant.model)
        ? [...slugs, { slug: assistant.model, name: assistant.model }]
        : slugs;
    return {
      instanceId,
      label,
      choices: [
        { instanceId, model: null, label: `${label} · Default model` },
        ...models.map((model) => ({
          instanceId,
          model: model.slug,
          label: `${label} · ${model.name}`,
        })),
      ],
    };
  };

  const groups = instances.map((instance) =>
    buildGroup(
      instance.id,
      buildInstanceLabel(instances, instance),
      buildThreadModelField(instance, null, undefined).options,
    ),
  );
  const instance = instances.find(({ id }) => id === assistant.instanceId);
  if (instance === undefined) {
    const { instanceId, model } = assistant;
    const label = `${toIdTail(instanceId)} (not found)`;
    groups.push({
      instanceId,
      label,
      choices: [{ instanceId, model, label: `${label} · ${model ?? "Default model"}` }],
    });
  }
  return {
    groups,
    providerId: instance?.providerId ?? null,
    hint:
      instance === undefined
        ? ""
        : (instance.snapshots.find(({ auth }) => auth.identity !== undefined)?.auth.identity ??
          instance.displayName),
  };
};
