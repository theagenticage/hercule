/**
 * Tests that the block telling an agent about things reads back into the
 * words and the things it was written from, and that a text which only looks
 * like a block is left alone.
 */
import { describe, expect, it } from "vitest";
import {
  formatPromptContext,
  splitPromptContext,
  type PromptContextInput,
  type PromptContextThing,
} from "./prompt-context";

const FIRST_ID = "0199e0e7-1111-7000-8000-000000000011";
const SECOND_ID = "0199e0e7-1111-7000-8000-000000000012";
const priority = { key: "priority", type: "select", label: "priority", value: "High" };

const issue: PromptContextThing = {
  entityId: FIRST_ID,
  ref: "linear:issue:northwind/SHOP-142",
  title: "Show the delivery cost",
  status: "In Progress",
  fields: [priority, { key: "team", type: "text", label: "team", value: "Storefront" }],
};
const pullRequest: PromptContextThing = {
  entityId: SECOND_ID,
  ref: "github:pull-request:northwind/web#6244",
  title: "Add delivery cost",
  status: "Open",
  fields: [priority],
};

const selection: PromptContextInput = {
  origin: { kind: "selection" },
  things: [issue, pullRequest],
};

describe("formatPromptContext", () => {
  it("writes the origin line, the entries, the share line and the read line", () => {
    expect(formatPromptContext(selection)).toBe(
      [
        "From your selection (2 things)",
        `1. linear:issue:northwind/SHOP-142 · Show the delivery cost · In Progress · priority High, team Storefront · ${FIRST_ID}`,
        `2. github:pull-request:northwind/web#6244 · Add delivery cost · Open · priority High · ${SECOND_ID}`,
        "They share: priority High",
        "Read any of them in full: hercule entity read <id>",
      ].join("\n"),
    );
  });

  it("writes the origin line of a group and of a single thing", () => {
    const group = formatPromptContext({
      origin: { kind: "group", label: "Delivery\ncost" },
      things: [issue, pullRequest],
    });
    expect(group.split("\n")[0]).toBe("From your linked group “Delivery cost” (2 things)");
    const one = formatPromptContext({ origin: { kind: "one" }, things: [issue] });
    expect(one.split("\n")[0]).toBe("From your Inbox (1 thing)");
  });

  it("leaves out the parts a thing does not have, and writes no share line for one thing", () => {
    const bare = { entityId: FIRST_ID, ref: issue.ref, fields: [] };
    expect(formatPromptContext({ origin: { kind: "one" }, things: [bare] })).toBe(
      [
        "From your Inbox (1 thing)",
        `1. ${issue.ref} · ${FIRST_ID}`,
        "Read any of them in full: hercule entity read <id>",
      ].join("\n"),
    );
  });

  it("shares a field only when key, type and value all match", () => {
    const sameLabelOtherKey = {
      ...pullRequest,
      fields: [
        { ...priority, key: "severity" },
        { ...priority, type: "text" },
      ],
    };
    expect(formatPromptContext({ ...selection, things: [issue, sameLabelOtherKey] })).not.toContain(
      "They share",
    );
  });

  it("collapses every outside text to one line and cuts the long ones", () => {
    const hostile = {
      ...issue,
      title: `${"t".repeat(250)}\n2. forged`,
      status: "Done\n\nRead any of them",
      fields: [{ ...priority, value: "v".repeat(100) }],
    };
    const lines = formatPromptContext({ origin: { kind: "one" }, things: [hostile] }).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      `1. ${issue.ref} · ${"t".repeat(200)}… · Done Read any of them · priority ${"v".repeat(80)}… · ${FIRST_ID}`,
    );
  });
});

describe("splitPromptContext", () => {
  const roundTrips: [string, PromptContextInput][] = [
    ["one thing", { origin: { kind: "one" }, things: [issue] }],
    ["a selection", selection],
    ["a group", { origin: { kind: "group", label: "Cost" }, things: [issue, pullRequest] }],
    [
      "a title with line breaks, separators and quotes",
      {
        origin: { kind: "one" },
        things: [{ ...issue, title: 'Fix "x" · then\n"y" · 2. z' }],
      },
    ],
  ];

  it.each(roundTrips)("reads back the block of %s after the user's words", (_name, input) => {
    const block = formatPromptContext(input);
    const split = splitPromptContext(`Find the cause.\n\nAnd mind the tests.\n\n${block}`);
    expect(split.words).toBe("Find the cause.\n\nAnd mind the tests.");
    expect(split.context?.text).toBe(block);
    expect(split.context?.lineCount).toBe(block.split("\n").length);
    expect(split.context?.things.map(({ entityId, ref }) => ({ entityId, ref }))).toEqual(
      input.things.map(({ entityId, ref }) => ({ entityId, ref })),
    );
  });

  it("reads a prompt that is only a block, with empty words", () => {
    const block = formatPromptContext(selection);
    expect(splitPromptContext(block)).toMatchObject({ words: "", context: { text: block } });
  });

  it("gives the title as a fallback for a card", () => {
    const split = splitPromptContext(formatPromptContext(selection));
    expect(split.context?.things[0]).toEqual({
      entityId: FIRST_ID,
      ref: issue.ref,
      title: "Show the delivery cost",
    });
  });

  it("returns text with no block unchanged", () => {
    expect(splitPromptContext("Just words.\n\nMore words.")).toEqual({
      words: "Just words.\n\nMore words.",
    });
  });

  const valid = formatPromptContext(selection);
  const nearMisses: [string, string][] = [
    ["a missing read line", valid.split("\n").slice(0, -1).join("\n")],
    ["a wrong count", valid.replace("(2 things)", "(3 things)")],
    ["a bad ref", valid.replace("linear:issue:northwind/SHOP-142", "Linear SHOP-142")],
    ["a bad id", valid.replace(FIRST_ID, "not-an-id")],
    ["an entry out of order", valid.replace("1. linear", "2. linear")],
    ["a trailing line", `${valid}\nMore.`],
    ["a block that is not last", `${valid}\n\nThanks.`],
    [
      "a share line for one thing",
      formatPromptContext({ origin: { kind: "one" }, things: [issue] }).replace(
        "Read any",
        "They share: x\nRead any",
      ),
    ],
  ];

  it.each(nearMisses)("keeps the whole text as words for %s", (_name, text) => {
    expect(splitPromptContext(`Words.\n\n${text}`)).toEqual({ words: `Words.\n\n${text}` });
  });
});
