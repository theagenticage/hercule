/** Tests `readFieldWords`, which words one face field for a row or a card. */
import { describe, expect, it } from "vitest";
import type { EntityFieldValue } from "@hercule/contract";
import { formatCompactNumber, formatWholeNumber, readFieldWords } from "./field-words";

const NOW = new Date("2026-09-10T12:00:00.000Z");

describe("readFieldWords", () => {
  const events: EntityFieldValue = { key: "events", type: "number", label: "Events", number: 1211 };

  it("writes a number with its label in the form it is given", () => {
    expect(readFieldWords(events, formatCompactNumber)).toBe("1.2k events");
    expect(readFieldWords(events, formatWholeNumber)).toBe("1,211 events");
  });

  it("writes text, a person and an enum as their text, and nothing for empty text", () => {
    const person: EntityFieldValue = { key: "owner", type: "person", label: "Owner", text: "Ada" };
    const priority: EntityFieldValue = {
      key: "priority",
      type: "enum",
      label: "Priority",
      value: "high",
      text: "High",
    };
    const empty: EntityFieldValue = { key: "note", type: "text", label: "Note", text: "" };
    expect(readFieldWords(person, formatWholeNumber)).toBe("Ada");
    expect(readFieldWords(priority, formatWholeNumber)).toBe("High");
    expect(readFieldWords(empty, formatWholeNumber)).toBeUndefined();
  });

  it("writes money in its currency", () => {
    const money: EntityFieldValue = {
      key: "value",
      type: "money",
      label: "Value",
      amount: 1200,
      currency: "GBP",
    };
    expect(readFieldWords(money, formatWholeNumber)).toBe("£1,200.00");
  });

  it("writes a flag as its label only when it is set", () => {
    const flag = (value: boolean): EntityFieldValue => ({
      key: "k",
      type: "bool",
      label: "Blocked",
      value,
    });
    expect(readFieldWords(flag(true), formatWholeNumber)).toBe("Blocked");
    expect(readFieldWords(flag(false), formatWholeNumber)).toBeUndefined();
  });

  it("writes an age only when it is given the time to measure it from", () => {
    const age: EntityFieldValue = {
      key: "opened",
      type: "age",
      label: "Opened",
      since: "2026-09-07T12:00:00.000Z",
    };
    expect(readFieldWords(age, formatWholeNumber, NOW)).toBe("3d");
    expect(readFieldWords(age, formatWholeNumber)).toBeUndefined();
  });

  it("writes nothing for a field that is missing", () => {
    expect(readFieldWords(undefined, formatWholeNumber)).toBeUndefined();
  });
});
