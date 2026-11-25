/**
 * Builds the model catalog of an Antigravity account from the settings `agy`
 * sends when a session starts (spec 06 section 3.3). The catalog needs no
 * second source: `agy` lists its models in the `model` config option and their
 * effort levels as extra model ids.
 */
import type { ConfigOption, SessionSettings } from "@hercule/acp";
import type { ModelDescriptor, ModelOption } from "@hercule/protocol";
import { truncateFact } from "../text";

/** The levels in the order a person reads them, lowest first. */
const EFFORT_ORDER = ["minimal", "low", "medium", "high", "xhigh", "max"];

/** The maker named by the start of a model's id. */
const MAKERS_BY_PREFIX: ReadonlyArray<readonly [prefix: string, maker: string]> = [
  ["gemini-", "Google"],
  ["claude-", "Anthropic"],
  ["gpt-", "OpenAI"],
];

interface EffortLevel {
  readonly value: string;
  readonly label: string;
}

/** Returns the select option with the id `id`, or `undefined` when `agy` sent none. */
const findSelectOption = (
  configOptions: ReadonlyArray<ConfigOption>,
  id: string,
): (ConfigOption & { readonly type: "select" }) | undefined =>
  configOptions.find(
    (option): option is ConfigOption & { readonly type: "select" } =>
      option.id === id && option.type === "select",
  );

/** Returns the maker of the model with the id `slug`, or `undefined` when its id does not say. */
const readMaker = (slug: string): string | undefined =>
  MAKERS_BY_PREFIX.find(([prefix]) => slug.startsWith(prefix))?.[1];

/**
 * Returns the label of an effort level: the text in the parentheses that end
 * the entry's name, such as `XHigh` for "Gemini 4 Hydrogen (XHigh)". Returns
 * the level itself when the name has no such text.
 */
const readLevelLabel = (entryName: string, level: string): string => {
  const inParentheses = /\(([^()]*)\)\s*$/.exec(entryName)?.[1]?.trim();
  return inParentheses === undefined || inParentheses === "" ? level : inParentheses;
};

/**
 * Groups the ids in `availableModels` by the model they are a level of. An id
 * is a level of the model with the longest value that the id starts with,
 * followed by a `-`. An id that is itself a model's value is a model, never a
 * level. Each level keeps the order `agy` listed it in.
 */
const groupLevelsByModel = (
  modelValues: ReadonlySet<string>,
  availableModels: NonNullable<SessionSettings["models"]>["availableModels"],
): ReadonlyMap<string, ReadonlyArray<EffortLevel>> => {
  const levelsByModel = new Map<string, Map<string, EffortLevel>>();
  for (const { modelId, name } of availableModels) {
    if (modelValues.has(modelId)) continue;
    // A longer prefix replaces a shorter one, so the last match is the longest.
    let owner: string | undefined;
    let level = "";
    for (let dash = modelId.indexOf("-"); dash !== -1; dash = modelId.indexOf("-", dash + 1)) {
      if (modelValues.has(modelId.slice(0, dash))) {
        owner = modelId.slice(0, dash);
        level = modelId.slice(dash + 1);
      }
    }
    if (owner === undefined || level === "") continue;
    const levels = levelsByModel.get(owner) ?? new Map<string, EffortLevel>();
    if (!levels.has(level)) levels.set(level, { value: level, label: readLevelLabel(name, level) });
    levelsByModel.set(owner, levels);
  }
  return new Map([...levelsByModel].map(([model, levels]) => [model, [...levels.values()]]));
};

/**
 * Builds the `effort` option of a model from its levels, listed lowest first
 * whatever order `agy` used. The default is the account's current level when
 * the model lists it, else the first level `agy` listed for it. A level that
 * is not in `EFFORT_ORDER` goes after the known ones, in the order `agy` gave.
 */
const buildEffortOption = (
  levels: ReadonlyArray<EffortLevel>,
  currentLevel: string | undefined,
): ModelOption => {
  const defaultLevel = levels.find((level) => level.value === currentLevel) ?? levels[0]!;
  const rank = (level: EffortLevel): number => {
    const position = EFFORT_ORDER.indexOf(level.value);
    return position === -1 ? EFFORT_ORDER.length : position;
  };
  return {
    // A well-known option id: the composer recognises reasoning effort by the
    // id `effort`, whatever the harness calls it (spec 06 section 3.3).
    id: "effort",
    label: "Effort",
    kind: "select",
    choices: [...levels]
      .sort((a, b) => rank(a) - rank(b))
      .map((level) => ({ value: truncateFact(level.value), label: truncateFact(level.label) })),
    default: truncateFact(defaultLevel.value),
  };
};

/**
 * Builds the catalog from the settings `agy` sent for a new session. Returns
 * an empty list when `agy` sent no `model` option. A model whose value or
 * name is empty is left out, because the protocol refuses it.
 *
 * `imageInput` is `null` for every model: `agy` declares images for the agent
 * as a whole, and a model that is not known to take them must not pass as
 * one that does.
 */
export const buildModelCatalog = (
  settings: Pick<SessionSettings, "configOptions" | "models">,
): ReadonlyArray<ModelDescriptor> => {
  const modelOption = findSelectOption(settings.configOptions, "model");
  if (modelOption === undefined) return [];
  // A select option may group its choices, so the groups are flattened.
  const choices = modelOption.options.flatMap((choice) =>
    "options" in choice ? choice.options : [choice],
  );
  const models = choices.filter((choice) => choice.value !== "" && choice.name !== "");
  const levelsByModel = groupLevelsByModel(
    new Set(models.map((model) => model.value)),
    settings.models?.availableModels ?? [],
  );
  const currentLevel = findSelectOption(settings.configOptions, "thought_level")?.currentValue;

  return models.map((model) => {
    const maker = readMaker(model.value);
    const levels = levelsByModel.get(model.value);
    return {
      slug: truncateFact(model.value),
      name: truncateFact(model.name),
      ...(model.value === modelOption.currentValue ? { isDefault: true } : {}),
      ...(maker === undefined ? {} : { maker }),
      imageInput: null,
      options: levels === undefined ? [] : [buildEffortOption(levels, currentLevel)],
    };
  });
};
