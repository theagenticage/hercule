import { describe, expect, it } from "vitest";
import type { EntityFieldType } from "./entities";
import {
  findClauseListProblem,
  interpretClauseValue,
  listClauseValues,
  splitClauseWord,
  splitSearchValue,
  type ClauseValue,
  type InboxClauseOperator,
} from "./clause-grammar";

describe("the clause value grammar", () => {
  it.each<{
    type: EntityFieldType;
    op: InboxClauseOperator;
    value: ClauseValue;
    // The value read, or the cause of the refusal.
    expected: { value: ClauseValue } | { cause: "operator" | "value" };
  }>([
    // Text, person and enum values stay text, whatever they look like.
    { type: "text", op: "is", value: "001", expected: { value: "001" } },
    { type: "text", op: "is", value: "true", expected: { value: "true" } },
    { type: "text", op: "is", value: "2d", expected: { value: "2d" } },
    { type: "enum", op: "is", value: "P2", expected: { value: "P2" } },
    { type: "person", op: "is", value: "Mei", expected: { value: "Mei" } },
    { type: "text", op: "over", value: "3", expected: { cause: "operator" } },
    { type: "text", op: "is", value: 3, expected: { cause: "value" } },
    // Booleans take yes and no, or true and false, in any case.
    { type: "bool", op: "is", value: "yes", expected: { value: true } },
    { type: "bool", op: "is", value: "TRUE", expected: { value: true } },
    { type: "bool", op: "is", value: "no", expected: { value: false } },
    { type: "bool", op: "is", value: "false", expected: { value: false } },
    { type: "bool", op: "is", value: true, expected: { value: true } },
    { type: "bool", op: "is", value: "maybe", expected: { cause: "value" } },
    { type: "bool", op: "over", value: "yes", expected: { cause: "operator" } },
    // Numbers take is, over and under.
    { type: "number", op: "is", value: "5", expected: { value: 5 } },
    { type: "number", op: "over", value: "9".repeat(309), expected: { cause: "value" } },
    { type: "number", op: "over", value: "1000", expected: { value: 1000 } },
    { type: "money", op: "under", value: "-2.5", expected: { value: -2.5 } },
    { type: "number", op: "over", value: 7, expected: { value: 7 } },
    { type: "number", op: "over", value: "big", expected: { cause: "value" } },
    { type: "number", op: "over", value: "2d", expected: { cause: "value" } },
    // Durations take over and under, with a unit of s, m, h, d or w.
    { type: "age", op: "over", value: "30s", expected: { value: 30 } },
    { type: "age", op: "over", value: "90m", expected: { value: 5_400 } },
    { type: "age", op: "under", value: "3h", expected: { value: 10_800 } },
    { type: "age", op: "over", value: "2d", expected: { value: 172_800 } },
    { type: "age", op: "over", value: "1w", expected: { value: 604_800 } },
    { type: "age", op: "over", value: "1.5h", expected: { value: 5_400 } },
    { type: "age", op: "over", value: 86_400, expected: { value: 86_400 } },
    { type: "age", op: "over", value: "2y", expected: { cause: "value" } },
    { type: "age", op: "over", value: `${"9".repeat(309)}s`, expected: { cause: "value" } },
    { type: "age", op: "over", value: `${"9".repeat(305)}w`, expected: { cause: "value" } },
    { type: "age", op: "over", value: "2", expected: { cause: "value" } },
    { type: "age", op: "is", value: "2d", expected: { cause: "operator" } },
  ])("reads $value on $type with $op", ({ type, op, value, expected }) => {
    const reading = interpretClauseValue("key", type, op, value);

    if ("value" in expected) expect(reading).toEqual({ ok: true, value: expected.value });
    else expect(reading).toMatchObject({ ok: false, cause: expected.cause });
  });

  it("says what to write when it refuses", () => {
    expect(interpretClauseValue("waiting", "age", "is", "2d")).toMatchObject({
      reason: 'waiting takes "over" or "under", not "is", such as waiting>2d.',
    });
  });

  it.each<{
    op: InboxClauseOperator;
    operand: ClauseValue | ReadonlyArray<ClauseValue>;
    values: ReadonlyArray<ClauseValue>;
    refused: boolean;
  }>([
    { op: "is", operand: "a", values: ["a"], refused: false },
    { op: "is", operand: ["a", "b"], values: ["a", "b"], refused: false },
    { op: "over", operand: 5, values: [5], refused: false },
    { op: "over", operand: [5, 6], values: [5, 6], refused: true },
    { op: "under", operand: ["1d"], values: ["1d"], refused: true },
  ])(
    "reads $operand with $op as $values (refused: $refused)",
    ({ op, operand, values, refused }) => {
      expect(listClauseValues(operand)).toEqual(values);
      expect(findClauseListProblem("key", op, operand) !== undefined).toBe(refused);
    },
  );

  it("says what to write when a list does not fit the operator", () => {
    expect(findClauseListProblem("size", "over", [1, 2])).toBe(
      'size takes a list of values only with "is", not "over". Give one value, or use "is".',
    );
  });

  it.each([
    { word: "team=Checkout", expected: { key: "team", op: "is", raw: "Checkout" } },
    { word: "waiting>2d", expected: { key: "waiting", op: "over", raw: "2d" } },
    { word: "size<5", expected: { key: "size", op: "under", raw: "5" } },
    { word: "nonsense", expected: undefined },
    { word: "team=", expected: undefined },
  ])("splits the word $word", ({ word, expected }) => {
    expect(splitClauseWord(word)).toEqual(expected);
  });

  it.each([
    { typed: ">1000", expected: { op: "over", raw: "1000" } },
    { typed: "<2d", expected: { op: "under", raw: "2d" } },
    { typed: "Checkout", expected: { op: "is", raw: "Checkout" } },
  ])("splits the search value $typed", ({ typed, expected }) => {
    expect(splitSearchValue(typed)).toEqual(expected);
  });
});
