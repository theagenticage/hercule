import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { SetupStep } from "./connections";
import { HarnessProviderSupport, HarnessWord } from "./contributions";
import { AccountKind, HarnessLoginStep, ProviderDefinition } from "./providers";

const accepts = (schema: Schema.Top, input: unknown): boolean =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>)(input))._tag ===
  "Success";

const omitField = (value: Record<string, unknown>, key: string) => {
  const copy = { ...value };
  delete copy[key];
  return copy;
};

const kind = {
  id: "subscription-per-machine",
  title: "Claude subscription",
  description: "Signed in on each machine.",
  setup: [{ kind: "harness-login", method: "sign-in" }],
  harnesses: ["claude-code/claude-code"],
};

describe("an account kind", () => {
  it("can sign in with the harness's own login", () => {
    expect(accepts(AccountKind, kind)).toBe(true);
  });

  it("needs the method of its harness login, and accepts only the login methods", () => {
    expect(accepts(HarnessLoginStep, { kind: "harness-login" })).toBe(false);
    expect(accepts(HarnessLoginStep, { kind: "harness-login", method: "sign-in" })).toBe(true);
    expect(accepts(HarnessLoginStep, { kind: "harness-login", method: "create-token" })).toBe(true);
    expect(accepts(HarnessLoginStep, { kind: "harness-login", method: "paste" })).toBe(false);
  });

  it("takes a key check with a url and headers", () => {
    const keyCheck = {
      url: "https://api.example.com/v1/models",
      headers: { authorization: "Bearer {apiKey}" },
    };
    expect(accepts(AccountKind, { ...kind, keyCheck })).toBe(true);
    expect(accepts(AccountKind, { ...kind, keyCheck: { url: keyCheck.url } })).toBe(false);
    expect(accepts(AccountKind, { ...kind, keyCheck: { ...keyCheck, headers: { a: 1 } } })).toBe(
      false,
    );
  });

  it("takes a usage declaration read by sessions, by a harness or by an endpoint", () => {
    const endpoint = {
      readBy: "endpoint",
      url: "https://api.example.com/v1/usage",
      headers: { authorization: "{apiKey}" },
    };
    expect(accepts(AccountKind, { ...kind, usage: { readBy: "sessions" } })).toBe(true);
    expect(
      accepts(AccountKind, {
        ...kind,
        usage: { readBy: "harness", harnessId: "claude-code/claude-code" },
      }),
    ).toBe(true);
    expect(accepts(AccountKind, { ...kind, usage: endpoint })).toBe(true);
  });

  it("refuses a usage declaration that is incomplete or reads another way", () => {
    expect(accepts(AccountKind, { ...kind, usage: { readBy: "endpoint", headers: {} } })).toBe(
      false,
    );
    expect(accepts(AccountKind, { ...kind, usage: { readBy: "harness" } })).toBe(false);
    expect(accepts(AccountKind, { ...kind, usage: { readBy: "telepathy" } })).toBe(false);
  });

  it("can use every step a Connection type can", () => {
    const steps = [
      { kind: "checklist", markdown: "Do this first." },
      { kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] },
      { kind: "oauth" },
      { kind: "device" },
      { kind: "pairing" },
    ];
    for (const step of steps) {
      expect(accepts(AccountKind, { ...kind, setup: [step] })).toBe(true);
    }
  });

  it("names its harnesses by qualified id", () => {
    expect(accepts(AccountKind, { ...kind, harnesses: ["claude-code"] })).toBe(false);
    expect(accepts(AccountKind, { ...kind, harnesses: ["Claude Code/claude-code"] })).toBe(false);
  });

  it("does not take a qualified id as its own id", () => {
    expect(accepts(AccountKind, { ...kind, id: "anthropic/api-key" })).toBe(false);
  });
});

describe("a Connection type's setup step", () => {
  it("cannot be the harness login", () => {
    expect(accepts(SetupStep, { kind: "harness-login", method: "sign-in" })).toBe(false);
  });
});

describe("a provider definition", () => {
  const provider = {
    id: "anthropic",
    displayName: "Anthropic",
    kinds: [kind],
    defaultHarnessId: "claude-code/claude-code",
    catalogSource: { kind: "harness-probe", harnessId: "claude-code/claude-code" },
    defaultSelection: "current-models",
  };

  it("needs at least one account kind", () => {
    expect(accepts(ProviderDefinition, provider)).toBe(true);
    expect(accepts(ProviderDefinition, { ...provider, kinds: [] })).toBe(false);
  });

  it("needs a default harness, named by qualified id", () => {
    expect(accepts(ProviderDefinition, omitField(provider, "defaultHarnessId"))).toBe(false);
    expect(accepts(ProviderDefinition, { ...provider, defaultHarnessId: "claude-code" })).toBe(
      false,
    );
  });

  it("needs a catalog source: a harness probe of a qualified harness id, or the provider's API", () => {
    expect(accepts(ProviderDefinition, omitField(provider, "catalogSource"))).toBe(false);
    expect(
      accepts(ProviderDefinition, {
        ...provider,
        catalogSource: {
          kind: "provider-api",
          url: "https://api.example.com/models",
          headers: { Authorization: "Bearer {apiKey}" },
        },
      }),
    ).toBe(true);
    // A provider-api source names a request, not a harness.
    expect(
      accepts(ProviderDefinition, {
        ...provider,
        catalogSource: { kind: "provider-api", harnessId: "claude-code/claude-code" },
      }),
    ).toBe(false);
    expect(
      accepts(ProviderDefinition, {
        ...provider,
        catalogSource: { kind: "harness-probe", harnessId: "claude-code" },
      }),
    ).toBe(false);
  });

  it("needs a default selection of current models or none", () => {
    expect(accepts(ProviderDefinition, omitField(provider, "defaultSelection"))).toBe(false);
    expect(accepts(ProviderDefinition, { ...provider, defaultSelection: "none" })).toBe(true);
    expect(accepts(ProviderDefinition, { ...provider, defaultSelection: "all" })).toBe(false);
  });

  it("takes an optional text generation model, which cannot be empty", () => {
    expect(
      accepts(ProviderDefinition, { ...provider, suggestedTextGenerationModel: "haiku" }),
    ).toBe(true);
    expect(accepts(ProviderDefinition, { ...provider, suggestedTextGenerationModel: "" })).toBe(
      false,
    );
  });
});

describe("what a harness declares it runs", () => {
  const kind = { kind: "api-key", modelArgument: "zai/{model}", credentialVariable: "ZAI_API_KEY" };
  const support = {
    providerId: "zai/zai",
    kinds: [kind],
    models: "own-list",
  };

  it("accepts a qualified provider, a model argument and a credential variable", () => {
    expect(accepts(HarnessProviderSupport, support)).toBe(true);
  });

  it("leaves the credential variable out for a kind whose login is in the Harness Home", () => {
    expect(
      accepts(HarnessProviderSupport, {
        ...support,
        kinds: [{ kind: "subscription-per-machine", modelArgument: "{model}" }],
      }),
    ).toBe(true);
  });

  it("accepts a different model argument for each kind of one provider", () => {
    expect(
      accepts(HarnessProviderSupport, {
        ...support,
        kinds: [
          { kind: "go-key", modelArgument: "opencode-go/{model}" },
          { kind: "zen-key", modelArgument: "opencode/{model}" },
        ],
      }),
    ).toBe(true);
  });

  it("refuses a kind without a model argument", () => {
    expect(accepts(HarnessProviderSupport, { ...support, kinds: [{ kind: "api-key" }] })).toBe(
      false,
    );
  });

  it.each([
    ["an unqualified provider id", { providerId: "zai" }],
    ["a model argument without {model}", { kinds: [{ ...kind, modelArgument: "zai/model" }] }],
    [
      "a model argument with {model} twice",
      { kinds: [{ ...kind, modelArgument: "{model}/{model}" }] },
    ],
    ["a model argument with another brace", { kinds: [{ ...kind, modelArgument: "{model}}" }] }],
    [
      "a model argument over the wire's length",
      { kinds: [{ ...kind, modelArgument: `${"a".repeat(128)}{model}` }] },
    ],
    [
      "a credential variable over the wire's length",
      { kinds: [{ ...kind, credentialVariable: "A".repeat(129) }] },
    ],
    [
      "a credential variable in lower case",
      { kinds: [{ ...kind, credentialVariable: "zai_key" }] },
    ],
    ["an unknown model scope", { models: "some" }],
  ])("refuses %s", (_label, change) => {
    expect(accepts(HarnessProviderSupport, { ...support, ...change })).toBe(false);
  });
});

describe("a credential variable a harness declares", () => {
  it.each([
    "PATH",
    "GH_TOKEN",
    "NODE_OPTIONS",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "HERCULE_HOME",
    "GIT_ASKPASS",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "PI_CODING_AGENT_DIR",
  ])("refuses the reserved variable %s", (variable) => {
    const support = {
      providerId: "zai/zai",
      kinds: [{ kind: "api-key", modelArgument: "zai/{model}", credentialVariable: variable }],
      models: "own-list",
    };

    expect(accepts(HarnessProviderSupport, support)).toBe(false);
  });
});

describe("a harness id", () => {
  it.each(["claude-code", "pi", "Codex_2.v1", "a".repeat(64)])("accepts %s", (word) => {
    expect(accepts(HarnessWord, word)).toBe(true);
  });

  it.each(["", "my harness", "-pi", ".pi", "_pi", "a/b", "hârness", "a".repeat(65)])(
    "refuses %j, because it names a folder in the Harness Home",
    (word) => {
      expect(accepts(HarnessWord, word)).toBe(false);
    },
  );
});
