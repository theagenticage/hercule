/**
 * Tests `decideAccountState` and `describeCredentialExpiry`: which state a
 * Provider Account is in, in which order the checks run, the words of each
 * state, and the button that fixes it.
 */
import { describe, expect, it } from "vitest";
import type { Provider, ProviderAccount } from "@hercule/contract";
import {
  decideAccountState,
  describeCredentialExpiry,
  findCredentialReplacement,
} from "./account-state";
import {
  ANTHROPIC_IDENTITY,
  PROVIDERS,
  ZAI_IDENTITY,
  buildProviderAccount,
  buildSnapshot,
} from "./providers.testing";

const NOW = new Date("2026-10-31T10:50:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

const TOKEN_PROVIDERS: ReadonlyArray<Provider> = [
  ...PROVIDERS,
  {
    id: "anthropic/token",
    pluginId: "anthropic",
    displayName: "Anthropic",
    defaultHarnessId: "claude-code/claude-code",
    kinds: [
      {
        id: "subscription-token",
        title: "Claude subscription, every machine",
        description: "A token that lasts a year.",
        setup: [{ kind: "harness-login", method: "create-token" }],
        harnesses: ["claude-code/claude-code"],
      },
    ],
  },
];

const KEY_ACCOUNT = buildProviderAccount(ZAI_IDENTITY);
const TOKEN_ACCOUNT: ProviderAccount = {
  ...buildProviderAccount({
    ...ANTHROPIC_IDENTITY,
    id: "account-token",
    providerId: "anthropic/token",
    kind: "subscription-token",
  }),
  expiresAt: new Date(NOW.getTime() + 300 * DAY).toISOString(),
};
const SIGNED_IN = buildProviderAccount(ANTHROPIC_IDENTITY, [buildSnapshot()]);

const decide = (account: ProviderAccount) =>
  decideAccountState(TOKEN_PROVIDERS, account, "UTC", NOW);
const expiresIn = (account: ProviderAccount, ms: number): ProviderAccount => ({
  ...account,
  expiresAt: new Date(NOW.getTime() + ms).toISOString(),
});

describe("decideAccountState", () => {
  it("is ok for a key, a token and a per-machine account that need nothing", () => {
    expect(decide(KEY_ACCOUNT)).toEqual({ kind: "ok" });
    expect(decide(TOKEN_ACCOUNT)).toEqual({ kind: "ok" });
    expect(decide(SIGNED_IN)).toEqual({ kind: "ok" });
  });

  it("says a key was refused, with the provider's words and a button to replace it", () => {
    const failure = { message: "401 Unauthorized", failedAt: "2026-10-31T09:14:00.000Z" };

    expect(decide({ ...KEY_ACCOUNT, failure })).toEqual({
      kind: "failed",
      tone: "fail",
      text: "Key refused",
      detail: "at 09:14",
      message: "401 Unauthorized",
      fix: { kind: "replace-key", label: "Replace key" },
    });
  });

  it("says a token was refused, with a button to make a new one", () => {
    const failure = { message: "Token revoked", failedAt: "2026-10-30T09:14:00.000Z" };

    expect(decide({ ...TOKEN_ACCOUNT, failure })).toMatchObject({
      text: "Token refused",
      detail: "at 30 Oct 09:14",
      fix: { kind: "new-token", label: "Make a new token" },
    });
  });

  it("checks a refusal before an expiry, and an expiry before a missing sign-in", () => {
    const failure = { message: "no", failedAt: "2026-10-31T09:14:00.000Z" };
    const expired = expiresIn(TOKEN_ACCOUNT, -DAY);

    expect(decide({ ...expired, failure }).kind).toBe("failed");
    expect(decide(expired).kind).toBe("expired");
  });

  it("says a token that has expired is expired, in the fail tone", () => {
    expect(decide(expiresIn(TOKEN_ACCOUNT, -3 * DAY))).toEqual({
      kind: "expired",
      tone: "fail",
      text: "Expired",
      detail: "on 28 Oct",
      message: null,
      fix: { kind: "new-token", label: "Make a new token" },
    });
  });

  it("counts the days to an expiry the way a person does, in calendar days", () => {
    const text = (ms: number) => {
      const state = decide(expiresIn(TOKEN_ACCOUNT, ms));
      return state.kind === "ok" ? "ok" : state.text;
    };

    expect(text(12 * DAY)).toBe("Expires in 12 days");
    // 10:50 now; 20 hours on is 06:50 tomorrow, and 14 hours on is 00:50 tomorrow.
    expect(text(20 * 3_600_000)).toBe("Expires tomorrow");
    expect(text(14 * 3_600_000)).toBe("Expires tomorrow");
    expect(text(5 * 3_600_000)).toBe("Expires today");
    expect(text(30 * DAY)).toBe("Expires in 30 days");
  });

  it("warns in the attention tone from 30 days before the expiry, and not before", () => {
    expect(decide(expiresIn(TOKEN_ACCOUNT, 30 * DAY))).toMatchObject({
      kind: "expiring",
      tone: "attention",
      detail: "on 30 Nov",
      fix: { kind: "new-token", label: "Make a new token" },
    });
    expect(decide(expiresIn(TOKEN_ACCOUNT, 30 * DAY + 1)).kind).toBe("ok");
  });

  it("names the year of an expiry that is not this year", () => {
    expect(decide(expiresIn(TOKEN_ACCOUNT, -DAY * 365))).toMatchObject({
      detail: "on 31 Oct 2025",
    });
  });

  it("offers to replace a key that expires, such as an OpenRouter key", () => {
    expect(decide(expiresIn(KEY_ACCOUNT, 5 * DAY))).toMatchObject({
      kind: "expiring",
      fix: { kind: "replace-key", label: "Replace key" },
    });
  });

  it("says a per-machine account is signed out when no machine has it signed in", () => {
    const signedOut = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({ auth: { status: "unauthenticated" } }),
    ]);

    expect(decide(signedOut)).toEqual({
      kind: "signed-out",
      tone: "fail",
      text: "Signed out",
      detail: null,
      message: null,
      fix: { kind: "sign-in", label: "Sign in" },
    });
    expect(decide(buildProviderAccount(ANTHROPIC_IDENTITY)).kind).toBe("signed-out");
  });

  it("is not signed out while one machine has the account signed in", () => {
    const oneMachine = buildProviderAccount(ANTHROPIC_IDENTITY, [
      buildSnapshot({ runnerId: "a", auth: { status: "unauthenticated" } }),
      buildSnapshot({ runnerId: "b" }),
    ]);

    expect(decide(oneMachine)).toEqual({ kind: "ok" });
  });

  it("offers no button for an account whose kind is no longer declared", () => {
    const orphan = { ...KEY_ACCOUNT, providerId: "gone/gone" };

    expect(
      decide({ ...orphan, failure: { message: "no", failedAt: "2026-10-31T09:14:00.000Z" } }),
    ).toMatchObject({ text: "Credential refused", fix: null });
  });
});

describe("describeCredentialExpiry", () => {
  it("names the date a credential expires, with the year when it is not this year", () => {
    expect(describeCredentialExpiry(expiresIn(TOKEN_ACCOUNT, 365 * DAY), "UTC", NOW)).toBe(
      "Expires 31 Oct 2027",
    );
    expect(describeCredentialExpiry(expiresIn(TOKEN_ACCOUNT, 12 * DAY), "UTC", NOW)).toBe(
      "Expires 12 Nov",
    );
  });

  it("says Expired once the date has passed", () => {
    expect(describeCredentialExpiry(expiresIn(TOKEN_ACCOUNT, -2 * DAY), "UTC", NOW)).toBe(
      "Expired 29 Oct",
    );
  });

  it("returns nothing for a credential that does not expire", () => {
    expect(describeCredentialExpiry(KEY_ACCOUNT, "UTC", NOW)).toBeNull();
  });
});

describe("findCredentialReplacement", () => {
  it("offers the button that gives a key or a token account a new credential", () => {
    expect(findCredentialReplacement(TOKEN_PROVIDERS, KEY_ACCOUNT)).toEqual({
      kind: "replace-key",
      label: "Replace key",
    });
    expect(findCredentialReplacement(TOKEN_PROVIDERS, TOKEN_ACCOUNT)).toEqual({
      kind: "new-token",
      label: "Make a new token",
    });
  });

  it("offers none for an account that signs in on each machine", () => {
    expect(findCredentialReplacement(TOKEN_PROVIDERS, SIGNED_IN)).toBeNull();
  });
});
