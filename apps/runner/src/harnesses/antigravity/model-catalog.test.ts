/**
 * Tests that `buildModelCatalog` turns the settings of a new `agy` session
 * into the catalog the account shows: first with the reply of a real `agy`
 * (a recording), then with made-up settings for the cases the recording does
 * not have.
 */
import type { SessionSettings } from "@hercule/acp";
import { readRecording } from "@hercule/acp/testing";
import { google } from "@hercule/plugin-google";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { buildModelCatalog } from "./model-catalog";

/** Reads the reply to `session/new` of a recording. The reply has the shape of `SessionSettings`. */
const readNewSessionSettings = (): SessionSettings => {
  const reply = readRecording("cancel").find(
    ({ direction, message }) =>
      direction === "in" &&
      typeof message.result === "object" &&
      message.result !== null &&
      "sessionId" in message.result &&
      "configOptions" in message.result,
  );
  return reply?.message.result as SessionSettings;
};

type Settings = Pick<SessionSettings, "configOptions" | "models">;

/** Builds settings from model values and names, the ids and names of `availableModels`, and the current level. */
const makeSettings = (
  models: ReadonlyArray<readonly [value: string, name: string]>,
  available: ReadonlyArray<readonly [modelId: string, name: string]>,
  currentLevel = "high",
  currentModel = models[0]?.[0] ?? "",
): Settings => ({
  configOptions: [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: currentModel,
      options: models.map(([value, name]) => ({ value, name })),
    },
    {
      id: "thought_level",
      name: "Thinking Level",
      type: "select",
      currentValue: currentLevel,
      options: [],
    },
  ],
  models: {
    currentModelId: "",
    availableModels: available.map(([modelId, name]) => ({ modelId, name })),
  },
});

const readEffortChoices = (settings: Settings, slug: string): ReadonlyArray<string> =>
  buildModelCatalog(settings)
    .find((model) => model.slug === slug)
    ?.options.flatMap((option) => option.choices?.map((choice) => choice.value) ?? []) ?? [];

describe("buildModelCatalog", () => {
  it("builds the catalog of a real agy session", () => {
    const effort = (
      choices: ReadonlyArray<readonly [string, string]>,
      defaultLevel: string,
    ): Array<unknown> => [
      {
        id: "effort",
        label: "Effort",
        kind: "select",
        choices: choices.map(([value, label]) => ({ value, label })),
        default: defaultLevel,
      },
    ];

    expect(buildModelCatalog(readNewSessionSettings())).toEqual([
      {
        slug: "gemini-4-hydrogen",
        name: "Gemini 4 Hydrogen",
        isDefault: true,
        maker: "Google",
        imageInput: null,
        options: effort(
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
            ["xhigh", "XHigh"],
          ],
          "high",
        ),
      },
      {
        slug: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        maker: "Google",
        imageInput: null,
        options: effort(
          [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
          ],
          "high",
        ),
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6 (Thinking)",
        maker: "Anthropic",
        imageInput: null,
        options: [],
      },
      {
        slug: "claude-opus-4-6-thinking",
        name: "Claude Opus 4.6 (Thinking)",
        maker: "Anthropic",
        imageInput: null,
        options: [],
      },
      {
        // The id ends in a level, but it is a model's own value, so it is a
        // model with no levels and never a level of another model.
        slug: "gpt-oss-120b-medium",
        name: "GPT-OSS 120B (Medium)",
        maker: "OpenAI",
        imageInput: null,
        options: [],
      },
    ]);
  });

  it("gives a level to the model with the longest matching value", () => {
    const settings = makeSettings(
      [
        ["gemini-4", "Gemini 4"],
        ["gemini-4-hydrogen", "Gemini 4 Hydrogen"],
      ],
      [
        ["gemini-4-hydrogen-high", "Gemini 4 Hydrogen (High)"],
        ["gemini-4-low", "Gemini 4 (Low)"],
      ],
    );

    expect(readEffortChoices(settings, "gemini-4-hydrogen")).toEqual(["high"]);
    expect(readEffortChoices(settings, "gemini-4")).toEqual(["low"]);
  });

  it("starts at the account's current level when the model lists it", () => {
    const settings = makeSettings(
      [["gemini-x", "Gemini X"]],
      [
        ["gemini-x-low", "Gemini X (Low)"],
        ["gemini-x-medium", "Gemini X (Medium)"],
      ],
      "medium",
    );

    expect(buildModelCatalog(settings)[0]?.options[0]?.default).toBe("medium");
  });

  it("starts at the first listed level when the model does not list the current one", () => {
    const settings = makeSettings(
      [["gemini-x", "Gemini X"]],
      [
        ["gemini-x-medium", "Gemini X (Medium)"],
        ["gemini-x-low", "Gemini X (Low)"],
      ],
      "xhigh",
    );

    const option = buildModelCatalog(settings)[0]?.options[0];
    expect(option?.default).toBe("medium");
    // The default is picked before the levels are sorted.
    expect(option?.choices?.map((choice) => choice.value)).toEqual(["low", "medium"]);
  });

  it("lists levels lowest first, and unknown levels last in the order agy gave", () => {
    const settings = makeSettings(
      [["gemini-x", "Gemini X"]],
      [
        ["gemini-x-turbo", "Gemini X (Turbo)"],
        ["gemini-x-max", "Gemini X (Max)"],
        ["gemini-x-high", "Gemini X (High)"],
        ["gemini-x-ultra", "Gemini X (Ultra)"],
        ["gemini-x-minimal", "Gemini X (Minimal)"],
        ["gemini-x-xhigh", "Gemini X (XHigh)"],
        ["gemini-x-low", "Gemini X (Low)"],
        ["gemini-x-medium", "Gemini X (Medium)"],
      ],
    );

    expect(readEffortChoices(settings, "gemini-x")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "turbo",
      "ultra",
    ]);
  });

  it("labels a level with the level itself when the name has no parentheses", () => {
    const settings = makeSettings(
      [["gemini-x", "Gemini X"]],
      [
        ["gemini-x-low", "Gemini X low"],
        ["gemini-x-high", "Gemini X ()"],
      ],
    );

    expect(buildModelCatalog(settings)[0]?.options[0]?.choices).toEqual([
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ]);
  });

  it("gives no maker to a model whose id names none", () => {
    const [model] = buildModelCatalog(makeSettings([["llama-70b", "Llama 70B"]], []));

    expect(model).toBeDefined();
    expect(model).not.toHaveProperty("maker");
  });

  it("marks only the account's current model as the default", () => {
    const catalog = buildModelCatalog(
      makeSettings(
        [
          ["gemini-a", "A"],
          ["gemini-b", "B"],
        ],
        [],
        "high",
        "gemini-b",
      ),
    );

    expect(catalog.map((model) => model.isDefault)).toEqual([undefined, true]);
  });

  it("flattens a model option that groups its choices, and leaves out an empty value or name", () => {
    const catalog = buildModelCatalog({
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "gemini-b",
          options: [
            { name: "One", options: [{ value: "gemini-a", name: "A" }] },
            {
              name: "Two",
              options: [
                { value: "gemini-b", name: "B" },
                { value: "", name: "No value" },
                { value: "gemini-c", name: "" },
              ],
            },
          ],
        },
      ],
    });

    expect(catalog.map((model) => model.slug)).toEqual(["gemini-a", "gemini-b"]);
  });

  it("returns no models without a model option or without a list of model ids", () => {
    expect(buildModelCatalog({ configOptions: [] })).toEqual([]);
    expect(buildModelCatalog(makeSettings([], [["gemini-x-low", "Gemini X (Low)"]]))).toEqual([]);

    const [model] = buildModelCatalog({
      configOptions: makeSettings([["gemini-x", "X"]], []).configOptions,
    });
    expect(model?.options).toEqual([]);
  });

  it("gives the maker that Google's default selection asks for", async () => {
    // The default selection of the Google provider keeps the models of one
    // maker, compared by exact name. If the two spellings drift apart, the
    // selection would be empty.
    const registered: Array<{ readonly defaultSelectionMaker?: string }> = [];
    await Effect.runPromise(
      google.register({
        providers: {
          register: (definition) =>
            Effect.sync(() => {
              registered.push(definition);
            }),
        },
      }),
    );
    const [geminiModel] = buildModelCatalog(readNewSessionSettings());

    expect(geminiModel?.maker).toBe(registered[0]?.defaultSelectionMaker);
  });
});
