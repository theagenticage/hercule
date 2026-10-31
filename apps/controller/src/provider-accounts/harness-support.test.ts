import { describe, expect, it } from "vitest";
import type { HarnessDefinition, ProviderDefinition } from "@hercule/plugin-host";
import type { RegisteredHarness, RegisteredProvider } from "../plugins";
import { buildHarnessDefinition } from "../plugins/testing";
import { checkHarnessSupport } from "./harness-support";

const PROVIDER: RegisteredProvider = {
  id: "vendor/vendor",
  displayName: "Vendor",
  kinds: [
    {
      id: "api-key",
      title: "API key",
      description: "A key.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      harnesses: ["alpha/alpha", "beta/beta"],
    },
    {
      id: "subscription",
      title: "Subscription",
      description: "A plan.",
      setup: [{ kind: "harness-login" }],
      harnesses: ["alpha/alpha"],
    },
  ],
} satisfies ProviderDefinition & { id: string };

const buildHarness = (id: string, runs: HarnessDefinition["runs"]): RegisteredHarness => ({
  ...buildHarnessDefinition(id, runs),
  id: `${id}/${id}`,
});

const ALPHA = buildHarness("alpha", [
  {
    providerId: "vendor/vendor",
    kinds: [{ kind: "api-key", credentialVariable: "VENDOR_API_KEY" }, { kind: "subscription" }],
    modelArgument: "vendor/{model}",
    models: "own-list",
  },
]);

/** Allowed by the provider for `api-key`, but its `runs` lists no such provider. */
const BETA = buildHarness("beta", []);

const ACCOUNT = { providerId: "vendor/vendor", kind: "api-key" };

describe("checkHarnessSupport", () => {
  it("returns how the harness runs the account when the provider allows it and the harness supports it", () => {
    expect(checkHarnessSupport([PROVIDER], ALPHA, ACCOUNT)).toEqual({
      _tag: "supported",
      modelArgument: "vendor/{model}",
      models: "own-list",
      credentialVariable: "VENDOR_API_KEY",
    });
  });

  it("returns no credential variable for a kind whose login lives in the Harness Home", () => {
    expect(
      checkHarnessSupport([PROVIDER], ALPHA, { providerId: "vendor/vendor", kind: "subscription" }),
    ).toMatchObject({ _tag: "supported", credentialVariable: undefined });
  });

  it("refuses a harness the provider's kind does not list, saying the provider does not allow it", () => {
    const gamma = buildHarness("gamma", ALPHA.runs);

    expect(checkHarnessSupport([PROVIDER], gamma, ACCOUNT)).toEqual({
      _tag: "refused",
      reason: "Vendor does not allow API key accounts to run in Harness gamma",
    });
  });

  it("refuses a harness the provider allows but whose runs does not list the provider", () => {
    expect(checkHarnessSupport([PROVIDER], BETA, ACCOUNT)).toEqual({
      _tag: "refused",
      reason: "Harness beta cannot run Vendor API key accounts",
    });
  });

  it("refuses a harness whose runs lists the provider but not this account kind", () => {
    const keysOnly = buildHarness("alpha", [
      { ...ALPHA.runs[0]!, kinds: [{ kind: "api-key", credentialVariable: "VENDOR_API_KEY" }] },
    ]);

    expect(
      checkHarnessSupport([PROVIDER], keysOnly, {
        providerId: "vendor/vendor",
        kind: "subscription",
      }),
    ).toEqual({
      _tag: "refused",
      reason: "Harness alpha cannot run Vendor Subscription accounts",
    });
  });

  it("refuses an account whose provider or kind this build does not have", () => {
    expect(checkHarnessSupport([], ALPHA, ACCOUNT)).toMatchObject({
      _tag: "refused",
      reason: expect.stringContaining("no vendor/vendor provider") as unknown,
    });
    expect(
      checkHarnessSupport([PROVIDER], ALPHA, { providerId: "vendor/vendor", kind: "token" }),
    ).toMatchObject({
      _tag: "refused",
      reason: expect.stringContaining("no account kind token") as unknown,
    });
  });
});
