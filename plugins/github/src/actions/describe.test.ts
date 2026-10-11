/**
 * Tests the lines a Signal shows for the GitHub answers: the describe line
 * before the click, read from the stored input, and the outcome line after.
 */
import { describe, expect, it } from "vitest";
import type { AnswerAction, DescribeLinePart } from "@hercule/plugin-host";
import { issueComment } from "./issue";
import { prComment, prMerge, prReview } from "./pr";

const ADDRESS = { repo: "acme/api", number: 113 };

/** Joins a describe line into plain text, with the marked parts in `**`, as markdown would show them. */
const joinLine = (parts: ReadonlyArray<DescribeLinePart>): string =>
  parts.map((part) => (part.kind === "marked" ? `**${part.text}**` : part.text)).join("");

/** Returns an action's describe line and outcome for `input`. */
const readLines = (action: object, input: unknown) => {
  const answer = action as Pick<AnswerAction, "describe" | "outcome">;
  return { describe: joinLine(answer.describe(input)), outcome: answer.outcome?.(input) };
};

describe("the answer lines of the GitHub actions", () => {
  it("names the pull request and the review verdict", () => {
    expect(readLines(prReview, { ...ADDRESS, verdict: "approve" })).toEqual({
      describe: "Approves pull request **#113** in **acme/api**",
      outcome: "Approved #113",
    });
    expect(readLines(prReview, { ...ADDRESS, verdict: "request-changes", body: "Fix it" })).toEqual(
      {
        describe: "Requests changes on pull request **#113** in **acme/api**, saying **Fix it**",
        outcome: "Requested changes on #113",
      },
    );
    expect(readLines(prReview, { ...ADDRESS, verdict: "comment" })).toEqual({
      describe: "Reviews pull request **#113** in **acme/api** with a comment",
      outcome: "Reviewed #113",
    });
  });

  it("names the item a comment goes to", () => {
    expect(readLines(prComment, ADDRESS)).toEqual({
      describe: "Comments on pull request **#113** in **acme/api**",
      outcome: "Commented on #113",
    });
    expect(readLines(issueComment, { ...ADDRESS, body: "On it" })).toEqual({
      describe: "Comments on issue **#113** in **acme/api**, saying **On it**",
      outcome: "Commented on #113",
    });
  });

  it("names every value a merge sends", () => {
    expect(readLines(prMerge, ADDRESS)).toEqual({
      describe: "Merges pull request **#113** in **acme/api**",
      outcome: "Merged #113",
    });
    const line = readLines(prMerge, {
      ...ADDRESS,
      method: "squash",
      commitTitle: "Ship it",
      sha: "6dcb09b",
      deleteBranch: true,
    }).describe;
    expect(line).toContain("as one squashed commit");
    expect(line).toContain("**Ship it**");
    expect(line).toContain("**6dcb09b**");
    expect(line).toContain("and deletes its branch");
  });

  it("still describes an input that names no item", () => {
    expect(readLines(prMerge, {})).toEqual({
      describe: "Merges a GitHub pull request",
      outcome: "Merged the pull request",
    });
  });
});
