/**
 * Tests what a client says about a Provider Account: its name
 * (`buildProviderAccountName`, `findProviderAccountNameIfAmbiguous`), and how it signs
 * in (`signsInPerMachine`, `listProviderAccountCredentialFields`).
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IDENTITY,
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
  findHarnessLoginMethod,
  findProviderAccountReadiness,
  findProviderAccountKind,
  findProviderAccountNameIfAmbiguous,
  findProviderPluginId,
  listProviderAccountCredentialFields,
  listSignedInDefaultHarnessSnapshots,
  signsInPerMachine,
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

const TOKEN_PROVIDERS = PROVIDERS.map((provider) =>
  provider.id === "anthropic/anthropic"
    ? {
        ...provider,
        kinds: [
          ...provider.kinds,
          {
            id: "subscription-token",
            title: "Claude subscription, every machine",
            description: "Sign in once.",
            setup: [{ kind: "harness-login" as const, method: "create-token" as const }],
            harnesses: ["claude-code/claude-code"],
          },
        ],
      }
    : provider,
);

describe("signsInPerMachine", () => {
  it("is true for a kind whose harness login is a sign-in, kept in the Harness Home of each machine", () => {
    expect(signsInPerMachine(PROVIDERS, ANTHROPIC)).toBe(true);
    expect(signsInPerMachine(PROVIDERS, OPENAI)).toBe(true);
  });

  it("is false for a harness-login kind that makes a token, which every machine uses", () => {
    expect(signsInPerMachine(TOKEN_PROVIDERS, { ...ANTHROPIC, kind: "subscription-token" })).toBe(
      false,
    );
  });

  it("is false for a key kind", () => {
    expect(signsInPerMachine(PROVIDERS, ZAI)).toBe(false);
  });

  it("is false when the provider no longer declares the account's kind", () => {
    expect(signsInPerMachine([], ANTHROPIC)).toBe(false);
    expect(signsInPerMachine(PROVIDERS, { ...ANTHROPIC, kind: "gone" })).toBe(false);
  });
});

describe("findHarnessLoginMethod", () => {
  it("names the method of a kind that signs in through its harness", () => {
    expect(findHarnessLoginMethod(PROVIDERS, ANTHROPIC)).toBe("sign-in");
    expect(
      findHarnessLoginMethod(TOKEN_PROVIDERS, {
        providerId: ANTHROPIC.providerId,
        kind: "subscription-token",
      }),
    ).toBe("create-token");
  });

  it("returns null for a kind whose user types the credential in", () => {
    expect(findHarnessLoginMethod(PROVIDERS, buildProviderAccount(ZAI_IDENTITY))).toBeNull();
  });

  it("returns null when the provider is no longer registered", () => {
    expect(findHarnessLoginMethod([], ANTHROPIC)).toBeNull();
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

describe("findProviderAccountReadiness", () => {
  const account = buildProviderAccount(
    ANTHROPIC_IDENTITY,
    [],
    [
      { runnerId: "moss" },
      { runnerId: "atlas", state: "not-signed-in" },
      { runnerId: "moss", harnessId: "pi/pi", state: "harness-too-old" },
    ],
  );

  it("is the state the controller sent for the harness on the runner", () => {
    expect(findProviderAccountReadiness(account, "claude-code/claude-code", "moss")).toBe("ready");
    expect(findProviderAccountReadiness(account, "claude-code/claude-code", "atlas")).toBe(
      "not-signed-in",
    );
    expect(findProviderAccountReadiness(account, "pi/pi", "moss")).toBe("harness-too-old");
  });

  it("is harness-missing when the account has no row for the pair", () => {
    expect(findProviderAccountReadiness(account, "claude-code/claude-code", "cove")).toBe(
      "harness-missing",
    );
    expect(findProviderAccountReadiness(account, "codex/codex", "moss")).toBe("harness-missing");
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
