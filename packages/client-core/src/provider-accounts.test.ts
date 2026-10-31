/**
 * Tests what a client says about a Provider Account: its name
 * (`buildProviderAccountName`, `findAccountNameIfAmbiguous`), and how it signs
 * in (`requiresSignInPerMachine`, `listAccountCredentialFields`).
 */
import { describe, expect, it } from "vitest";
import {
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  PROVIDERS,
  ZAI_IDENTITY,
  buildProviderAccount,
} from "./providers.testing";
import {
  buildProviderAccountName,
  describeAccountIdentity,
  findAccountKind,
  findAccountNameIfAmbiguous,
  listAccountCredentialFields,
  requiresSignInPerMachine,
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

describe("findAccountNameIfAmbiguous", () => {
  const WORK = { ...ANTHROPIC, id: "account-anthropic-work", label: "work" };

  it("names an account when the user has another at the same provider", () => {
    expect(findAccountNameIfAmbiguous([ANTHROPIC, WORK], PROVIDERS, WORK)).toBe("Anthropic · work");
    expect(findAccountNameIfAmbiguous([ANTHROPIC, WORK], PROVIDERS, ANTHROPIC)).toBe("Anthropic");
  });

  it("names nothing for an account that is alone at its provider, whatever other providers hold", () => {
    expect(findAccountNameIfAmbiguous([ANTHROPIC, OPENAI], PROVIDERS, ANTHROPIC)).toBeNull();
  });
});

describe("findAccountKind", () => {
  it("finds the kind the account was created as", () => {
    expect(findAccountKind(PROVIDERS, ZAI)?.id).toBe("api-key");
  });

  it("is undefined when the provider or the kind is no longer declared", () => {
    expect(findAccountKind([], ZAI)).toBeUndefined();
    expect(findAccountKind(PROVIDERS, { ...ZAI, kind: "gone" })).toBeUndefined();
  });
});

describe("requiresSignInPerMachine", () => {
  it("is true for a kind whose setup has a harness-login step", () => {
    expect(requiresSignInPerMachine(PROVIDERS, ANTHROPIC)).toBe(true);
    expect(requiresSignInPerMachine(PROVIDERS, OPENAI)).toBe(true);
  });

  it("is false for a kind that types its credential in", () => {
    expect(requiresSignInPerMachine(PROVIDERS, ZAI)).toBe(false);
  });

  it("is false when the kind is unknown, because nothing says it signs in on each machine", () => {
    expect(requiresSignInPerMachine([], ANTHROPIC)).toBe(false);
  });
});

describe("listAccountCredentialFields", () => {
  it("lists the fields of the kind's credentials step", () => {
    expect(listAccountCredentialFields(PROVIDERS, ZAI)).toEqual([
      { name: "apiKey", label: "API key" },
    ]);
  });

  it("lists none for a kind that signs in on each machine", () => {
    expect(listAccountCredentialFields(PROVIDERS, ANTHROPIC)).toEqual([]);
  });
});

describe("describeAccountIdentity", () => {
  it("is the identity and the plan of an account that knows who is signed in", () => {
    expect(
      describeAccountIdentity(PROVIDERS, {
        ...ANTHROPIC,
        identity: "rogier@acme.com",
        planLabel: "Max",
      }),
    ).toEqual({ text: "rogier@acme.com", plan: "Max" });
  });

  it("has no plan when the vendor reports none", () => {
    expect(
      describeAccountIdentity(PROVIDERS, { ...ANTHROPIC, identity: "rogier@acme.com" }),
    ).toEqual({ text: "rogier@acme.com", plan: null });
  });

  it("is the title of the kind for an account that knows no identity", () => {
    expect(describeAccountIdentity(PROVIDERS, ZAI)).toEqual({ text: "API key", plan: null });
  });

  it("is the kind's id when the provider no longer declares the kind", () => {
    expect(describeAccountIdentity([], ZAI)).toEqual({ text: "api-key", plan: null });
  });
});
