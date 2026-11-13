/** Tests how a stored field value is written as the text of a prompt's context block. */
import { describe, expect, it } from "vitest";
import type { EntityFieldValue } from "@hercule/contract";
import { describeFieldValue } from "./prompt-context";

const identity = { key: "k", label: "Label" };

describe("describeFieldValue", () => {
  it.each<[EntityFieldValue, string]>([
    [{ ...identity, type: "text", text: "Storefront" }, "Storefront"],
    [{ ...identity, type: "person", text: "Mei" }, "Mei"],
    [{ ...identity, type: "enum", value: "high", text: "High" }, "High"],
    [{ ...identity, type: "number", number: 3.5 }, "3.5"],
    [{ ...identity, type: "money", amount: 1200, currency: "GBP" }, "1200 GBP"],
    [{ ...identity, type: "age", since: "2026-03-01T00:00:00.000Z" }, "2026-03-01T00:00:00.000Z"],
    [{ ...identity, type: "bool", value: true }, "yes"],
    [{ ...identity, type: "bool", value: false }, "no"],
  ])("writes %j as %s", (field, text) => {
    expect(describeFieldValue(field)).toBe(text);
  });
});
