/**
 * Tests the details the model menu shows beside a row's name: "default" on
 * the account's default model unless it is the current one, and who is
 * logged in to an account and on what plan.
 */
import { describe, expect, it } from "vitest";
import type { ModelMenuInstanceRow, ModelMenuRow } from "./model-menu";
import { describeAccountRow, describeModelRow } from "./model-menu-details";

const SONNET: ModelMenuRow = {
  instanceId: "claude",
  slug: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  isDefault: true,
  current: false,
};

const ACCOUNT: ModelMenuInstanceRow = {
  instanceId: "work",
  providerId: "claude-code",
  name: "work",
  identity: "work@example.com",
  planLabel: "Claude Pro",
  models: "1 model",
  dimmed: null,
  login: null,
  rows: [],
};

describe("describeModelRow", () => {
  it("marks the account's default model", () => {
    expect(describeModelRow(SONNET)).toBe("default");
  });

  it("leaves the current model and every other model without a detail", () => {
    expect(describeModelRow({ ...SONNET, current: true })).toBeNull();
    expect(describeModelRow({ ...SONNET, isDefault: false })).toBeNull();
  });
});

describe("describeAccountRow", () => {
  it("names who is logged in and on what plan", () => {
    expect(describeAccountRow(ACCOUNT)).toBe("work@example.com · Claude Pro");
  });

  it("names only what the account knows", () => {
    expect(describeAccountRow({ ...ACCOUNT, identity: null })).toBe("Claude Pro");
    expect(describeAccountRow({ ...ACCOUNT, planLabel: null })).toBe("work@example.com");
    expect(describeAccountRow({ ...ACCOUNT, identity: null, planLabel: null })).toBeNull();
  });
});
