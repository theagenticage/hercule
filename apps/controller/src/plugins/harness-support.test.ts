import { describe, expect, it } from "vitest";
import type { HarnessDefinition, ProviderDefinition } from "@hercule/plugin-host";
import type { RegisteredHarness } from "./harnesses";
import type { RegisteredProvider } from "./providers";
import { buildHarnessDefinition } from "./testing";
import { decideProviderAccountHarness, listCredentialVariables } from "./harness-support";

const PROVIDER: RegisteredProvider = {
  id: "vendor/vendor",
  pluginId: "vendor",
  displayName: "Vendor",
  kinds: [
    {
      id: "api-key",
      title: "API key",
      description: "A key.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      keyCheck: { url: "https://api.example.com/v1/models", headers: {} },
      harnesses: ["alpha/alpha", "beta/beta"],
    },
    {
      id: "subscription",
      title: "Subscription",
      description: "A plan.",
      setup: [{ kind: "harness-login", method: "sign-in" }],
      harnesses: ["alpha/alpha"],
    },
  ],
  defaultHarnessId: "alpha/alpha",
  parseUsageBody: {},
  catalogSource: { kind: "harness-probe", harnessId: "alpha/alpha" },
  defaultSelection: "current-models",
} satisfies ProviderDefinition & {
  id: string;
  pluginId: string;
  parseUsageBody: object;
};

const buildHarness = (id: string, runs: HarnessDefinition["runs"]): RegisteredHarness => ({
  ...buildHarnessDefinition(id, runs),
  id: `${id}/${id}`,
});

const ALPHA = buildHarness("alpha", [
  {
    providerId: "vendor/vendor",
    kinds: [
      { kind: "api-key", modelArgument: "vendor/{model}", credentialVariable: "VENDOR_API_KEY" },
      // A different argument from `api-key`, so a test sees each kind get its own.
      { kind: "subscription", modelArgument: "vendor-sub/{model}" },
    ],
    models: "own-list",
  },
]);

/** Allowed by the provider for `api-key`, but its `runs` lists no such provider. */
const BETA = buildHarness("beta", []);

const GAMMA = buildHarness("gamma", ALPHA.runs);

const PROVIDERS = [PROVIDER];
const HARNESSES = [ALPHA, BETA, GAMMA];

const ACCOUNT = { providerId: "vendor/vendor", kind: "api-key", defaultHarnessId: "alpha/alpha" };

describe("decideProviderAccountHarness", () => {
  it("chooses the account's default harness when none is named, with its provider, kind and how it runs the account", () => {
    expect(decideProviderAccountHarness(PROVIDERS, HARNESSES, ACCOUNT)).toEqual({
      _tag: "chosen",
      provider: PROVIDER,
      kind: PROVIDER.kinds[0],
      harness: ALPHA,
      support: {
        modelArgument: "vendor/{model}",
        credentialVariable: "VENDOR_API_KEY",
        credentialSecretName: "apiKey",
      },
    });
  });

  it("chooses the named harness over the default, and treats null as not named", () => {
    const account = { ...ACCOUNT, defaultHarnessId: "beta/beta" };

    expect(
      decideProviderAccountHarness(PROVIDERS, HARNESSES, account, "alpha/alpha"),
    ).toMatchObject({
      _tag: "chosen",
      harness: ALPHA,
    });
    expect(decideProviderAccountHarness(PROVIDERS, HARNESSES, ACCOUNT, null)).toMatchObject({
      _tag: "chosen",
      harness: ALPHA,
    });
  });

  it("returns no credential variable for a kind whose login lives in the Harness Home, and that kind's own model argument", () => {
    expect(
      decideProviderAccountHarness(PROVIDERS, HARNESSES, { ...ACCOUNT, kind: "subscription" }),
    ).toMatchObject({
      _tag: "chosen",
      support: {
        modelArgument: "vendor-sub/{model}",
        credentialVariable: undefined,
        credentialSecretName: undefined,
      },
    });
  });

  it("refuses a harness the provider's kind does not list, saying the provider does not allow it", () => {
    expect(decideProviderAccountHarness(PROVIDERS, HARNESSES, ACCOUNT, "gamma/gamma")).toEqual({
      _tag: "refused",
      field: "harnessId",
      reason: "Vendor does not allow API key accounts to run in Harness gamma",
    });
  });

  it("refuses a harness the provider allows but whose runs does not list the provider", () => {
    expect(decideProviderAccountHarness(PROVIDERS, HARNESSES, ACCOUNT, "beta/beta")).toEqual({
      _tag: "refused",
      field: "harnessId",
      reason: "Harness beta cannot run Vendor API key accounts",
    });
  });

  it("refuses a harness whose runs lists the provider but not this account kind", () => {
    const keysOnly = buildHarness("alpha", [
      {
        ...ALPHA.runs[0]!,
        kinds: [
          {
            kind: "api-key",
            modelArgument: "vendor/{model}",
            credentialVariable: "VENDOR_API_KEY",
          },
        ],
      },
    ]);

    expect(
      decideProviderAccountHarness(PROVIDERS, [keysOnly], { ...ACCOUNT, kind: "subscription" }),
    ).toEqual({
      _tag: "refused",
      field: "providerAccountId",
      reason: "Harness alpha cannot run Vendor Subscription accounts",
    });
  });

  it("refuses a harness this build does not carry", () => {
    expect(decideProviderAccountHarness(PROVIDERS, HARNESSES, ACCOUNT, "delta/delta")).toEqual({
      _tag: "refused",
      field: "harnessId",
      reason: "this build carries no delta/delta harness",
    });
  });

  it("blames the account when its own default harness is the problem", () => {
    const account = { ...ACCOUNT, defaultHarnessId: "gamma/gamma" };

    expect(decideProviderAccountHarness(PROVIDERS, HARNESSES, account)).toMatchObject({
      _tag: "refused",
      field: "providerAccountId",
    });
    expect(decideProviderAccountHarness(PROVIDERS, [], ACCOUNT)).toMatchObject({
      _tag: "refused",
      field: "providerAccountId",
      reason: "this build carries no alpha/alpha harness",
    });
  });

  it("refuses an account whose provider or kind this build does not have", () => {
    expect(decideProviderAccountHarness([], HARNESSES, ACCOUNT)).toMatchObject({
      _tag: "refused",
      field: "providerAccountId",
      reason: expect.stringContaining("no vendor/vendor provider") as unknown,
    });
    expect(
      decideProviderAccountHarness(PROVIDERS, HARNESSES, { ...ACCOUNT, kind: "token" }),
    ).toMatchObject({
      _tag: "refused",
      field: "providerAccountId",
      reason: expect.stringContaining("no account kind token") as unknown,
    });
  });
});

describe("listCredentialVariables", () => {
  it("returns every credential variable of the harness across its providers and kinds, each once", () => {
    const harness = buildHarness("multi", [
      {
        providerId: "vendor/vendor",
        kinds: [
          { kind: "subscription", modelArgument: "{model}" },
          { kind: "token", modelArgument: "{model}", credentialVariable: "VENDOR_TOKEN" },
          { kind: "api-key", modelArgument: "{model}", credentialVariable: "VENDOR_API_KEY" },
        ],
        models: "all",
      },
      {
        providerId: "other/other",
        kinds: [
          { kind: "api-key", modelArgument: "other/{model}", credentialVariable: "VENDOR_API_KEY" },
          {
            kind: "api-key-2",
            modelArgument: "other/{model}",
            credentialVariable: "OTHER_API_KEY",
          },
        ],
        models: "own-list",
      },
    ]);

    expect(listCredentialVariables(harness)).toEqual([
      "VENDOR_TOKEN",
      "VENDOR_API_KEY",
      "OTHER_API_KEY",
    ]);
  });

  it("returns nothing for a harness whose accounts all sign in on the machine", () => {
    expect(listCredentialVariables(BETA)).toEqual([]);
    expect(
      listCredentialVariables(
        buildHarness("machine", [
          {
            providerId: "vendor/vendor",
            kinds: [{ kind: "subscription", modelArgument: "{model}" }],
            models: "all",
          },
        ]),
      ),
    ).toEqual([]);
  });
});
