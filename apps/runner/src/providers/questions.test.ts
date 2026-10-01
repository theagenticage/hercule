/**
 * Tests the headers a question request shows when the agent repeats one, and
 * that each answer still finds its question's vendor key. The adapter tests
 * cover the plain case; these cover a header that is already numbered and a
 * header too long to take a number.
 */
import { describe, expect, it } from "vitest";
import { MAX_FACT_LENGTH } from "@hercule/protocol";
import { buildQuestionRequest, keyAnswersForVendor } from "./questions";

const IDENTITY = { requestId: "req-1", itemId: "item-1" };

/** Returns a Claude-shaped question, keyed by its text. */
const buildAsked = (question: string, header: string) => ({
  question,
  header,
  options: [],
  multiSelect: false,
});

/** Returns the headers the request built from `given` shows, in order. */
const readHeaders = (given: unknown): ReadonlyArray<string> => {
  const request = buildQuestionRequest(IDENTITY, "AskUserQuestion", given, "question");
  if (request.kind !== "question") throw new Error(`expected a question, got ${request.kind}`);
  return request.detail.questions.map((question) => question.header);
};

describe("a repeated header", () => {
  it("takes the first number no earlier question shows, and leads back to its own question", () => {
    const given = [
      buildAsked("First?", "Approach"),
      buildAsked("Second?", "Approach (2)"),
      buildAsked("Third?", "Approach"),
    ];

    expect(readHeaders(given)).toEqual(["Approach", "Approach (2)", "Approach (3)"]);
    expect(
      keyAnswersForVendor(
        { Approach: "a", "Approach (2)": "b", "Approach (3)": "c" },
        given,
        "question",
      ),
    ).toEqual(
      new Map([
        ["First?", ["a"]],
        ["Second?", ["b"]],
        ["Third?", ["c"]],
      ]),
    );
  });

  it("is cut short to make room for its number when it is as long as a header may be", () => {
    const long = "h".repeat(MAX_FACT_LENGTH + 10);
    const given = [buildAsked("First?", long), buildAsked("Second?", long)];

    const [first, second] = readHeaders(given);

    expect(first).toBe(long.slice(0, MAX_FACT_LENGTH));
    expect(second).toBe(`${long.slice(0, MAX_FACT_LENGTH - 4)} (2)`);
    expect(keyAnswersForVendor({ [second!]: "b" }, given, "question")).toEqual(
      new Map([["Second?", ["b"]]]),
    );
  });
});
