/**
 * Tests what a client says about a Provider Account: its name
 * (`buildProviderAccountName`, `findProviderAccountNameIfAmbiguous`), and how it signs
 * in (`requiresSignInPerMachine`, `listProviderAccountCredentialFields`).
 */
import { describe, expect, it } from "vitest";
import type { Harness } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  HARNESSES,
  OPENAI_IDENTITY,
  PROVIDERS,
  ZAI_IDENTITY,
  buildProviderAccount,
  buildSnapshot,
} from "./providers.testing";
import {
  buildProviderAccountName,
  describeProviderAccountIdentity,
  findDefaultHarnessSnapshot,
  findProviderAccountKind,
  findProviderAccountNameIfAmbiguous,
  findProviderPluginId,
  listProviderAccountCredentialFields,
  listSignedInDefaultHarnessSnapshots,
  requiresSignInPerMachine,
  resolveThreadHarnessId,
} from "./provider-accounts";

const ANTHROPIC = buildProviderAccount(ANTHROPIC_IDENTITY);
const OPENAI = buildProviderAccount(OPENAI_IDENTITY);
const ZAI = buildProviderAccount(ZAI_IDENTITY);

describe("buildProviderAccountName", () => {
  it("is the provider's display name for an account with no label", () => {
    expect(buildProviderAccountName(PROVIDERS, ANTHROPIC)).toBe("Anthropic");
    expect(buildProviderAccountName(PROVIDERS, ZAI)).toBe("Z.ai");
  });

  it("adds the label after a middle dot", () => {
    expect(buildProviderAccountName(PROVIDERS, { ...OPENAI, label: "work" })).toBe("OpenAI · work");
  });

  it("falls back to the provider id when no plugin registers the provider any more", () => {
    expect(buildProviderAccountName([], { ...ANTHROPIC, label: "work" })).toBe(
      "anthropic/anthropic · work",
    );
  });
});

describe("findProviderAccountNameIfAmbiguous", () => {
  const WORK = { ...ANTHROPIC, id: "account-anthropic-work", label: "work" };

  it("names an account when the user has another at the same provider", () => {
    expect(findProviderAccountNameIfAmbiguous([ANTHROPIC, WORK], PROVIDERS, WORK)).toBe(
      "Anthropic · work",
    );
    expect(findProviderAccountNameIfAmbiguous([ANTHROPIC, WORK], PROVIDERS, ANTHROPIC)).toBe(
      "Anthropic",
    );
  });

  it("names nothing for an account that is alone at its provider, whatever other providers hold", () => {
    expect(
      findProviderAccountNameIfAmbiguous([ANTHROPIC, OPENAI], PROVIDERS, ANTHROPIC),
    ).toBeNull();
  });
});

describe("findProviderAccountKind", () => {
  it("finds the kind the account was created as", () => {
    expect(findProviderAccountKind(PROVIDERS, ZAI)?.id).toBe("api-key");
  });

  it("is undefined when the provider or the kind is no longer declared", () => {
    expect(findProviderAccountKind([], ZAI)).toBeUndefined();
    expect(findProviderAccountKind(PROVIDERS, { ...ZAI, kind: "gone" })).toBeUndefined();
  });
});

describe("requiresSignInPerMachine", () => {
  /** A kind with a harness-login step, whose harness keeps a token the controller holds: it works on every machine. */
  const TOKEN_HARNESS: Harness = {
    ...HARNESSES[0]!,
    runs: [
      {
        providerId: "anthropic/anthropic",
        kinds: [{ kind: "subscription-token", credentialVariable: "CLAUDE_CODE_OAUTH_TOKEN" }],
        modelArgument: "{model}",
        models: "all",
      },
    ],
  };
  const TOKEN_ACCOUNT = { ...ANTHROPIC, kind: "subscription-token" };

  it("is true for a kind whose harness declares no credential variable, so its login is in the Harness Home", () => {
    expect(requiresSignInPerMachine(HARNESSES, ANTHROPIC)).toBe(true);
    expect(requiresSignInPerMachine(HARNESSES, OPENAI)).toBe(true);
  });

  it("is false for a kind with a harness-login step whose harness declares a credential variable", () => {
    expect(requiresSignInPerMachine([TOKEN_HARNESS], TOKEN_ACCOUNT)).toBe(false);
  });

  it("is false for a key kind", () => {
    expect(requiresSignInPerMachine(HARNESSES, ZAI)).toBe(false);
  });

  it("reads the harness the call names instead of the account's default", () => {
    const named = { ...ANTHROPIC, defaultHarnessId: "pi/pi" };

    expect(requiresSignInPerMachine(HARNESSES, named)).toBe(false);
    expect(requiresSignInPerMachine(HARNESSES, named, "claude-code/claude-code")).toBe(true);
  });

  it("is false when no registered harness declares the account's provider and kind", () => {
    expect(requiresSignInPerMachine([], ANTHROPIC)).toBe(false);
    expect(requiresSignInPerMachine(HARNESSES, { ...ANTHROPIC, kind: "gone" })).toBe(false);
  });
});

describe("listProviderAccountCredentialFields", () => {
  it("lists the fields of the kind's credentials step", () => {
    expect(listProviderAccountCredentialFields(PROVIDERS, ZAI)).toEqual([
      { name: "apiKey", label: "API key" },
    ]);
  });

  it("lists none for a kind that signs in on each machine", () => {
    expect(listProviderAccountCredentialFields(PROVIDERS, ANTHROPIC)).toEqual([]);
  });
});

describe("describeProviderAccountIdentity", () => {
  it("is the identity and the plan of an account that knows who is signed in", () => {
    expect(
      describeProviderAccountIdentity(PROVIDERS, {
        ...ANTHROPIC,
        identity: "rogier@acme.com",
        planLabel: "Max",
      }),
    ).toEqual({ text: "rogier@acme.com", plan: "Max" });
  });

  it("has no plan when the vendor reports none", () => {
    expect(
      describeProviderAccountIdentity(PROVIDERS, { ...ANTHROPIC, identity: "rogier@acme.com" }),
    ).toEqual({ text: "rogier@acme.com", plan: null });
  });

  it("is the title of the kind for an account that knows no identity", () => {
    expect(describeProviderAccountIdentity(PROVIDERS, ZAI)).toEqual({
      text: "API key",
      plan: null,
    });
  });

  it("is the kind's id when the provider no longer declares the kind", () => {
    expect(describeProviderAccountIdentity([], ZAI)).toEqual({ text: "api-key", plan: null });
  });
});

describe("resolveThreadHarnessId", () => {
  it("is the named harness, or the account's default harness when none is named", () => {
    expect(resolveThreadHarnessId(ANTHROPIC, "pi/pi")).toBe("pi/pi");
    expect(resolveThreadHarnessId(ANTHROPIC, null)).toBe("claude-code/claude-code");
    expect(resolveThreadHarnessId(ANTHROPIC, undefined)).toBe("claude-code/claude-code");
  });
});

describe("the snapshots of an account's default harness", () => {
  const onMoss = buildSnapshot({ runnerId: "moss", harnessId: ANTHROPIC.defaultHarnessId });
  const onAtlas = buildSnapshot({
    runnerId: "atlas",
    harnessId: ANTHROPIC.defaultHarnessId,
    auth: { status: "unauthenticated" },
  });
  const otherHarness = buildSnapshot({ runnerId: "moss", harnessId: "pi/pi" });
  const account = {
    ...ANTHROPIC,
    snapshots: [onMoss, onAtlas, otherHarness],
  };

  it("finds the snapshot of one runner, whatever its login", () => {
    expect(findDefaultHarnessSnapshot(account, "atlas")).toBe(onAtlas);
    expect(findDefaultHarnessSnapshot(account, "nowhere")).toBeUndefined();
  });

  it("leaves out the snapshots of other harnesses", () => {
    expect(findDefaultHarnessSnapshot({ ...account, snapshots: [otherHarness] }, "moss")).toBe(
      undefined,
    );
  });

  it("lists only the snapshots that found the account signed in", () => {
    expect(listSignedInDefaultHarnessSnapshots(account)).toEqual([onMoss]);
    expect(listSignedInDefaultHarnessSnapshots({ ...account, snapshots: [otherHarness] })).toEqual(
      [],
    );
  });
});

describe("findProviderPluginId", () => {
  it("is the id of the plugin that registered the account's provider", () => {
    expect(findProviderPluginId(PROVIDERS, ZAI)).toBe("zai");
  });

  it("is null when no plugin registers the provider any more", () => {
    expect(findProviderPluginId([], ZAI)).toBeNull();
  });
});
