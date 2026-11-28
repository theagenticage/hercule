/**
 * Tests `buildAssistantProviderField(accounts, providers, modelProfiles,
 * assistant)`, which builds the Provider field of Settings > Assistants: one
 * group per Provider Account, its default model first, then the models the
 * Model Profiles list for it, the identity as the hint.
 */
import { describe, expect, it } from "vitest";
import type { ModelProfile, ProviderAccount } from "@hercule/contract";
import { toIdTail } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  PROVIDERS,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
} from "../providers.testing";
import { buildAssistantProviderField } from "./provider-field";

const PERSONAL = "01a06d02-7600-7000-8000-000000000001";
const WORK = "01a06d02-7600-7000-8000-000000000002";
const CODEX = "01a06d02-7600-7000-8000-000000000003";

const SIGNED_IN = "rogier@example.com";

/** Returns an account signed in as `identity`, or one that knows nobody when it is null. */
const buildAccount = (
  base: typeof ANTHROPIC_IDENTITY,
  id: string,
  identity: string | null,
): ProviderAccount => ({ ...buildProviderAccount({ ...base, id }), identity });

const claude = (id: string, label: string | null = null): ProviderAccount =>
  buildAccount({ ...ANTHROPIC_IDENTITY, label }, id, SIGNED_IN);

const codexSignedOut = (): ProviderAccount => buildAccount(OPENAI_IDENTITY, CODEX, null);

/** Returns a profile that lists Sonnet 5 and Opus 5 for each of the Claude accounts given. */
const profileOf = (...ids: string[]): ModelProfile =>
  buildModelProfile(
    ids.map((id) => {
      const identity = { ...ANTHROPIC_IDENTITY, id };
      return buildProfileSection(identity, [
        buildProfileEntry(identity, "claude-sonnet-5", { name: "Sonnet 5" }),
        buildProfileEntry(identity, "claude-opus-5", { name: "Opus 5" }),
      ]);
    }),
  );

describe("buildAssistantProviderField", () => {
  it("offers each account's default model, then the models its profile lists, named after the account", () => {
    const field = buildAssistantProviderField(
      [claude(PERSONAL)],
      PROVIDERS,
      [profileOf(PERSONAL)],
      {
        providerAccountId: PERSONAL,
        harnessId: null,
        model: null,
      },
    );

    const harnessId = null;
    expect(field.groups).toEqual([
      {
        providerAccountId: PERSONAL,
        label: "Anthropic",
        choices: [
          {
            providerAccountId: PERSONAL,
            harnessId,
            model: null,
            label: "Anthropic · Default model",
          },
          {
            providerAccountId: PERSONAL,
            harnessId,
            model: "claude-sonnet-5",
            label: "Anthropic · Sonnet 5",
          },
          {
            providerAccountId: PERSONAL,
            harnessId,
            model: "claude-opus-5",
            label: "Anthropic · Opus 5",
          },
        ],
      },
    ]);
    expect(field.harnessId).toBe("claude-code/claude-code");
    expect(field.hint).toBe("rogier@example.com");
  });

  it("names two accounts of one provider by their labels", () => {
    const accounts = [claude(PERSONAL), claude(WORK, "work")];

    const field = buildAssistantProviderField(accounts, PROVIDERS, [profileOf(PERSONAL, WORK)], {
      providerAccountId: WORK,
      harnessId: null,
      model: null,
    });

    expect(field.groups.map(({ label }) => label)).toEqual(["Anthropic", "Anthropic · work"]);
  });

  it("offers only the default model of an account that no profile lists", () => {
    const field = buildAssistantProviderField([codexSignedOut()], PROVIDERS, [], {
      providerAccountId: CODEX,
      harnessId: null,
      model: null,
    });

    expect(field.groups[0]?.choices).toEqual([
      { providerAccountId: CODEX, harnessId: null, model: null, label: "OpenAI · Default model" },
    ]);
    expect(field.hint).toBe("OpenAI");
  });

  it("keeps the assistant's model when no profile lists it", () => {
    const field = buildAssistantProviderField(
      [claude(PERSONAL)],
      PROVIDERS,
      [profileOf(PERSONAL)],
      {
        providerAccountId: PERSONAL,
        harnessId: null,
        model: "claude-sonnet-4",
      },
    );

    expect(field.groups[0]?.choices.at(-1)).toEqual({
      providerAccountId: PERSONAL,
      harnessId: null,
      model: "claude-sonnet-4",
      label: "Anthropic · claude-sonnet-4",
    });
  });

  it("keeps the assistant's model on an account that no profile lists", () => {
    const field = buildAssistantProviderField([codexSignedOut()], PROVIDERS, [], {
      providerAccountId: CODEX,
      harnessId: null,
      model: "gpt-6",
    });

    expect(field.groups[0]?.choices).toEqual([
      { providerAccountId: CODEX, harnessId: null, model: null, label: "OpenAI · Default model" },
      { providerAccountId: CODEX, harnessId: null, model: "gpt-6", label: "OpenAI · gpt-6" },
    ]);
  });

  it("does not add the assistant's model to another account's group", () => {
    const field = buildAssistantProviderField(
      [claude(PERSONAL), codexSignedOut()],
      PROVIDERS,
      [profileOf(PERSONAL)],
      {
        providerAccountId: PERSONAL,
        harnessId: null,
        model: "claude-sonnet-4",
      },
    );

    expect(field.groups[1]?.choices.map((choice) => choice.model)).toEqual([null]);
  });

  it("lists the entries of the assistant's own harness, and carries that harness on its own account's choices only", () => {
    const identity = { ...ANTHROPIC_IDENTITY, id: PERSONAL };
    const profile = buildModelProfile([
      buildProfileSection(identity, [
        buildProfileEntry(identity, "claude-sonnet-5", { name: "Sonnet 5" }),
        buildProfileEntry(identity, "glm-5.3", {
          name: "GLM 5.3",
          harnessId: "pi/pi",
          resolvedHarnessId: "pi/pi",
        }),
      ]),
      ...profileOf(WORK).accounts,
    ]);

    const field = buildAssistantProviderField(
      [claude(PERSONAL), claude(WORK)],
      PROVIDERS,
      [profile],
      { providerAccountId: PERSONAL, harnessId: "pi/pi", model: null },
    );

    expect(field.harnessId).toBe("pi/pi");
    expect(field.groups[0]?.choices).toEqual([
      {
        providerAccountId: PERSONAL,
        harnessId: "pi/pi",
        model: null,
        label: "Anthropic · Default model",
      },
      {
        providerAccountId: PERSONAL,
        harnessId: "pi/pi",
        model: "glm-5.3",
        label: "Anthropic · GLM 5.3",
      },
    ]);
    expect(field.groups[1]?.choices.every((choice) => choice.harnessId === null)).toBe(true);
  });

  it("lists a model once when several profiles hold it", () => {
    const field = buildAssistantProviderField(
      [claude(PERSONAL)],
      PROVIDERS,
      [profileOf(PERSONAL), { ...profileOf(PERSONAL), id: "profile-second" }],
      { providerAccountId: PERSONAL, harnessId: null, model: null },
    );

    expect(field.groups[0]?.choices.map((choice) => choice.model)).toEqual([
      null,
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
  });

  it.each([null, "claude-sonnet-5"])(
    "adds a deleted account as a last group holding only the assistant's choice, model %s",
    (model) => {
      const field = buildAssistantProviderField(
        [claude(PERSONAL)],
        PROVIDERS,
        [profileOf(PERSONAL)],
        {
          providerAccountId: WORK,
          harnessId: null,
          model,
        },
      );

      const label = `${toIdTail(WORK)} (not found)`;
      expect(field.groups.at(-1)).toEqual({
        providerAccountId: WORK,
        label,
        choices: [
          {
            providerAccountId: WORK,
            harnessId: null,
            model,
            label: `${label} · ${model ?? "Default model"}`,
          },
        ],
      });
      expect(field.harnessId).toBeNull();
      expect(field.hint).toBe("");
    },
  );
});
