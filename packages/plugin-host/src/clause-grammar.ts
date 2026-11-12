/**
 * The one grammar of a clause's value, shared by every place that reads one:
 * the `--clause` flag of the CLI, the Inbox search field, the checks that run
 * when a plugin loads, and the controller's query compiler.
 *
 * It has two layers:
 *
 * 1. Raw syntax. `splitClauseWord` and `splitSearchValue` cut a typed piece of
 *    text into an operator and a raw value string. They know nothing about
 *    fields, so `2d`, `true` and `001` are only strings here.
 * 2. Interpretation. `interpretClauseValue` reads the raw value for the type
 *    of the field the clause is on. Text, person and enum values stay text,
 *    so `001`, `true` and `2d` stay text on a text or enum field.
 *
 * This lives in plugin-host, and not in the public contract, because plugin
 * load checks need it and a plugin cannot import the contract.
 */
import type { EntityFieldType } from "./entities";

/** The operators of a clause. */
export type InboxClauseOperator = "is" | "over" | "under";

/** The value of a clause: raw text as typed, or a value already read for its field. */
export type ClauseValue = string | number | boolean;

/** The most values the list form of a clause's `is` holds. */
export const MAX_CLAUSE_VALUES = 8;

/**
 * What a clause is compared with: one value, or for `is` a short list that
 * means "any of these". The list is the grammar of the saved queries a plugin
 * declares and of the API. Neither the CLI's `--clause` nor the Inbox search
 * field produces one: they type a single value.
 */
export type ClauseOperand = ClauseValue | ReadonlyArray<ClauseValue>;

/** A clause cut into its parts, before any field says what the value means. */
export interface RawClause {
  readonly key: string;
  readonly op: InboxClauseOperator;
  readonly raw: string;
}

/** Seconds in each unit a duration takes. */
export const DURATION_UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400, w: 604_800 } as const;

/** Returns the values a clause is compared with: its one value, or each value of its list. */
export const listClauseValues = (operand: ClauseOperand): ReadonlyArray<ClauseValue> =>
  typeof operand === "object" ? operand : [operand];

/**
 * Returns the sentence that says why a clause cannot take a list of values, or
 * undefined when it can. A list is "any of these", so it only fits `is`;
 * `over` and `under` compare with one number. A clause with one value is
 * always fine.
 */
export const findClauseListProblem = (
  key: string,
  op: InboxClauseOperator,
  operand: ClauseOperand,
): string | undefined =>
  typeof operand === "object" && op !== "is"
    ? `${key} takes a list of values only with "is", not "${op}". Give one value, or use "is".`
    : undefined;

/** The operators a clause on a field of this type takes. */
export const CLAUSE_OPERATORS_BY_TYPE: Readonly<
  Record<EntityFieldType, ReadonlyArray<InboxClauseOperator>>
> = {
  text: ["is"],
  person: ["is"],
  enum: ["is"],
  bool: ["is"],
  number: ["is", "over", "under"],
  money: ["is", "over", "under"],
  age: ["over", "under"],
};

const SIGN_OPERATORS = { "=": "is", ">": "over", "<": "under" } as const;

/**
 * Splits the one-word form of a clause, `key=value`, `key>value` or
 * `key<value`, into its key, operator and raw value. Returns undefined for a
 * word that is not shaped like that.
 */
export const splitClauseWord = (word: string): RawClause | undefined => {
  const match = /^([A-Za-z0-9_-]+)([=><])(.+)$/.exec(word);
  if (match === null) return undefined;
  const [, key, sign, raw] = match as unknown as [string, string, "=" | ">" | "<", string];
  return { key, op: SIGN_OPERATORS[sign], raw };
};

/**
 * Splits the value typed after `key:` in the search field. A leading `>` or
 * `<` is the operator `over` or `under`; without one the operator is `is`.
 */
export const splitSearchValue = (typed: string): { op: InboxClauseOperator; raw: string } => {
  const sign = typed[0];
  return sign === ">" || sign === "<"
    ? { op: SIGN_OPERATORS[sign], raw: typed.slice(1) }
    : { op: "is", raw: typed };
};

/** What `interpretClauseValue` returns: the value read for the field, or why it cannot be. */
export type ClauseInterpretation =
  | { readonly ok: true; readonly value: ClauseValue }
  | {
      readonly ok: false;
      /** `operator` when the field does not take the operator, `value` when the value does not fit. */
      readonly cause: "operator" | "value";
      /** A sentence that says what is wrong and what to write instead. */
      readonly reason: string;
    };

const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;
const DURATION_TEXT = /^(\d+(?:\.\d+)?)([smhdw])$/;

const WORD_FOR_OPERATOR = { is: "=", over: ">", under: "<" } as const;

/**
 * Reads the value of a clause on the field `key` of `type`.
 *
 * - text, person and enum: `is` with the value kept as text, whatever it
 *   looks like.
 * - bool: `is` with `yes`, `no`, `true` or `false`, in any case.
 * - number and money: `is`, `over` or `under` with a finite number.
 * - age (a duration): `over` or `under` with a number of seconds, or a number
 *   with a unit, `s`, `m`, `h`, `d` or `w`, such as `2d` or `90m`.
 *
 * A value that is already typed (a boolean for a bool field, seconds for an
 * age) passes when it fits the type. Returns a refusal with a reason when the
 * operator or the value does not fit.
 */
export const interpretClauseValue = (
  key: string,
  type: EntityFieldType,
  op: InboxClauseOperator,
  value: ClauseValue,
): ClauseInterpretation => {
  const operators = CLAUSE_OPERATORS_BY_TYPE[type];
  if (!operators.includes(op)) {
    const takes = operators.map((allowed) => `"${allowed}"`).join(" or ");
    const example = operators[0]!;
    return {
      ok: false,
      cause: "operator",
      reason: `${key} takes ${takes}, not "${op}", such as ${key}${WORD_FOR_OPERATOR[example]}${EXAMPLE_VALUE[type]}.`,
    };
  }
  const refuse = (): ClauseInterpretation => ({
    ok: false,
    cause: "value",
    reason: `"${String(value)}" is not ${ARTICLE_FOR_TYPE[type]}, which ${key} needs. Write it like ${key}${WORD_FOR_OPERATOR[op]}${EXAMPLE_VALUE[type]}.`,
  });
  switch (type) {
    case "text":
    case "person":
    case "enum":
      return typeof value === "string" ? { ok: true, value } : refuse();
    case "bool": {
      if (typeof value === "boolean") return { ok: true, value };
      if (typeof value !== "string") return refuse();
      const word = value.toLowerCase();
      if (word === "yes" || word === "true") return { ok: true, value: true };
      if (word === "no" || word === "false") return { ok: true, value: false };
      return refuse();
    }
    case "number":
    case "money": {
      const number = typeof value === "string" && NUMBER_TEXT.test(value) ? Number(value) : value;
      return typeof number === "number" && Number.isFinite(number)
        ? { ok: true, value: number }
        : refuse();
    }
    case "age": {
      const duration = typeof value === "string" ? DURATION_TEXT.exec(value.toLowerCase()) : null;
      // Text such as 999...9s overflows to Infinity, once parsed and again once multiplied.
      const seconds =
        duration === null
          ? value
          : Number(duration[1]) *
            DURATION_UNIT_SECONDS[duration[2] as keyof typeof DURATION_UNIT_SECONDS];
      return typeof seconds === "number" && Number.isFinite(seconds)
        ? { ok: true, value: seconds }
        : refuse();
    }
  }
};

const ARTICLE_FOR_TYPE: Readonly<Record<EntityFieldType, string>> = {
  text: "a word",
  person: "a name",
  enum: "a word",
  bool: "yes or no",
  number: "a number",
  money: "an amount",
  age: "a duration",
};

const EXAMPLE_VALUE: Readonly<Record<EntityFieldType, string>> = {
  text: "word",
  person: "name",
  enum: "word",
  bool: "yes",
  number: "1000",
  money: "1000",
  age: "2d",
};
