/**
 * Tests how the answer of OpenRouter's key endpoint becomes a credit reading
 * and an expiry. The first answer is the example in OpenRouter's documentation
 * (https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key);
 * the others change one thing in it.
 */
import { describe, expect, it } from "vitest";
import { parseKeyBody } from "./key";

const TAKEN_AT = "2026-10-31T12:00:00.000Z";

/** The documented example: a key with a 100 dollar monthly limit, 74.5 of it left, that expires at the end of 2027. */
const DOCUMENTED = {
  data: {
    allowed_data_regions: ["global", "europe", "us"],
    budgets: [
      {
        budget_id: null,
        guardrail_id: "0df9e665-d932-5740-b2c7-b52af166bc11",
        include_byok: false,
        limit_usd: 50,
        remaining_usd: 17.5,
        reset_interval: "weekly",
        resets_at: "2026-10-12T00:00:00.000Z",
        scope: "member",
        spend_usd: 32.5,
      },
    ],
    byok_usage: 17.38,
    byok_usage_daily: 17.38,
    byok_usage_monthly: 17.38,
    byok_usage_weekly: 17.38,
    creator_user_id: "user_2dHFtVWx2n56w6HkM0000000000",
    effective_budget: {
      budget_id: null,
      guardrail_id: "0df9e665-d932-5740-b2c7-b52af166bc11",
      include_byok: false,
      limit_usd: 50,
      remaining_usd: 17.5,
      reset_interval: "weekly",
      resets_at: "2026-10-12T00:00:00.000Z",
      scope: "member",
      spend_usd: 32.5,
    },
    expires_at: "2027-12-31T23:59:59Z",
    free_model_daily_requests: { limit: 50, remaining: 38, used: 12 },
    include_byok_in_limit: false,
    is_free_tier: false,
    is_management_key: false,
    is_provisioning_key: false,
    label: "sk-or-v1-au7...890",
    limit: 100,
    limit_remaining: 74.5,
    limit_reset: "monthly",
    organization_id: null,
    rate_limit: {
      interval: "1h",
      note: "This field is deprecated and safe to ignore.",
      requests: 1000,
    },
    usage: 25.5,
    usage_daily: 25.5,
    usage_monthly: 25.5,
    usage_weekly: 25.5,
    workspace_id: "0df9e665-d932-5740-b2c7-b52af166bc11",
  },
};

/** The documented example with `changes` applied to its `data`. */
const withData = (changes: Record<string, unknown>) => ({
  data: { ...DOCUMENTED.data, ...changes },
});

/** Parses a key answer and returns its readings and expiry, failing the test if the parser refuses the key. */
const readKey = (body: unknown) => {
  const result = parseKeyBody(body, TAKEN_AT);
  if ("refused" in result) throw new Error(`the key was refused: ${result.refused}`);
  return result;
};

describe("parseKeyBody", () => {
  it("reads the credit left and the expiry from the documented example", () => {
    expect(readKey(DOCUMENTED)).toEqual({
      readings: [{ kind: "credit", remaining: 74.5, limit: 100, takenAt: TAKEN_AT }],
      expiresAt: "2027-12-31T23:59:59.000Z",
    });
  });

  it("gives no reading for a key with no limit, because the account balance is not on this endpoint", () => {
    expect(readKey(withData({ limit: null, limit_remaining: null, expires_at: null }))).toEqual({
      readings: [],
      expiresAt: null,
    });
  });

  it("gives no reading for a limit of zero", () => {
    expect(readKey(withData({ limit: 0, limit_remaining: 0 })).readings).toEqual([]);
  });

  it("never reports credit below zero for a key that spent past its limit", () => {
    expect(readKey(withData({ limit: 10, limit_remaining: -0.4, usage: 10.4 }))).toMatchObject({
      readings: [{ kind: "credit", remaining: 0, limit: 10 }],
    });
  });

  it("works the credit out from the usage when OpenRouter sends no remaining amount", () => {
    expect(readKey(withData({ limit: 100, limit_remaining: null, usage: 25.5 }))).toMatchObject({
      readings: [{ kind: "credit", remaining: 74.5, limit: 100 }],
    });
    expect(readKey(withData({ limit: 10, limit_remaining: null, usage: 12 }))).toMatchObject({
      readings: [{ kind: "credit", remaining: 0, limit: 10 }],
    });
  });

  it("reports that a key without an expiry does not expire, whether expires_at is null or absent", () => {
    const withoutExpiry = Object.fromEntries(
      Object.entries(DOCUMENTED.data).filter(([field]) => field !== "expires_at"),
    );

    expect(readKey(withData({ expires_at: null })).expiresAt).toBeNull();
    expect(readKey({ data: withoutExpiry }).expiresAt).toBeNull();
  });

  it("converts an expiry with an offset to UTC", () => {
    expect(readKey(withData({ expires_at: "2027-01-01T01:00:00+01:00" })).expiresAt).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it.each([
    ["no body", null],
    ["no data", {}],
    ["an error answer", { error: { message: "User not found.", code: 401 } }],
    ["no usage", { data: { limit: 100, limit_remaining: 74.5 } }],
    ["a limit that is not a number", withData({ limit: "100" })],
    ["an expiry that is not a date", withData({ expires_at: "never" })],
  ])("throws on %s", (_name, body) => {
    expect(() => parseKeyBody(body, TAKEN_AT)).toThrow();
  });
});
