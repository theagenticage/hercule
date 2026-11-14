/**
 * Tests that the block telling an agent about things reads back into the
 * words and the things it was written from, and that a text which only looks
 * like a block is left alone.
 */
import { describe, expect, it } from "vitest";
import type { EntityFieldValue } from "./groups/external-entity";
import {
  appendPromptContext,
  splitPromptContext,
  type PromptContextInput,
  type PromptContextThing,
} from "./prompt-context";

const FIRST_ID = "0199e0e7-1111-7000-8000-000000000011";
const SECOND_ID = "0199e0e7-1111-7000-8000-000000000012";
const priority: EntityFieldValue = {
  key: "priority",
  type: "enum",
  label: "priority",
  value: "high",
  text: "High",
};

/** Returns a text field whose label is its key. */
const textField = (key: string, text: string): Extract<EntityFieldValue, { type: "text" }> => ({
  key,
  type: "text",
  label: key,
  text,
});

/** Writes only the block of `input`, with no words before it. */
const formatPromptContext = (input: PromptContextInput): string => appendPromptContext("", input);

const issue: PromptContextThing = {
  entityId: FIRST_ID,
  ref: "linear:issue:northwind/SHOP-142",
  title: "Show the delivery cost",
  status: "In Progress",
  fields: [priority, textField("team", "Storefront")],
};
const pullRequest: PromptContextThing = {
  entityId: SECOND_ID,
  ref: "github:pull-request:northwind/web#6244",
  title: "Add delivery cost",
  status: "Open",
  fields: [priority],
};

const withoutTitle = (thing: PromptContextThing): PromptContextThing =>
  Object.fromEntries(
    Object.entries(thing).filter(([name]) => name !== "title"),
  ) as unknown as PromptContextThing;

const selection: PromptContextInput = {
  origin: { kind: "selection" },
  things: [issue, pullRequest],
};

describe("formatPromptContext", () => {
  it("writes the origin line, the entries, the share line and the read line", () => {
    expect(formatPromptContext(selection)).toBe(
      [
        "From your selection (2 things)",
        `1. linear:issue:northwind/SHOP-142 · “Show the delivery cost” · In Progress · priority High, team Storefront · ${FIRST_ID}`,
        `2. github:pull-request:northwind/web#6244 · “Add delivery cost” · Open · priority High · ${SECOND_ID}`,
        "They share: priority High",
        "Read any of them in full: hercule entity read <id>",
      ].join("\n"),
    );
  });

  it.each<[EntityFieldValue, string]>([
    [{ key: "k", label: "Label", type: "text", text: "Storefront" }, "Label Storefront"],
    [{ key: "k", label: "Label", type: "person", text: "Mei" }, "Label Mei"],
    [{ key: "k", label: "Label", type: "enum", value: "high", text: "High" }, "Label High"],
    [{ key: "k", label: "Label", type: "number", number: 3.5 }, "Label 3.5"],
    [{ key: "k", label: "Label", type: "money", amount: 1200, currency: "GBP" }, "Label 1200 GBP"],
    [
      { key: "k", label: "Label", type: "age", since: "2026-03-01T00:00:00.000Z" },
      "Label 2026-03-01T00:00:00.000Z",
    ],
    [{ key: "k", label: "Label", type: "bool", value: true }, "Label yes"],
    [{ key: "k", label: "Label", type: "bool", value: false }, "Label no"],
  ])("writes the field %j as %s", (field, text) => {
    const [, entry] = formatPromptContext({
      origin: { kind: "one" },
      things: [{ ...issue, fields: [field] }],
    }).split("\n");
    expect(entry).toContain(` · ${text} · ${FIRST_ID}`);
  });

  it("leaves out a field whose value is empty, and shares nothing for it", () => {
    const empty = textField("team", "  ");
    const block = formatPromptContext({
      ...selection,
      things: [
        { ...issue, fields: [empty] },
        { ...pullRequest, fields: [empty] },
      ],
    });
    expect(block).not.toContain("team");
    expect(block).not.toContain("They share");
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
      fields: [{ ...priority, key: "severity" }, { ...textField("priority", "High") }],
    };
    expect(formatPromptContext({ ...selection, things: [issue, sameLabelOtherKey] })).not.toContain(
      "They share",
    );
  });

  it("shares a ref-valued field only when the ref matches, not when the titles do", () => {
    const project = (ref: string): EntityFieldValue => ({
      ...textField("project", "Checkout"),
      ref,
    });
    const things = (secondRef: string) => [
      { ...issue, fields: [project("linear:project:northwind/checkout")] },
      { ...pullRequest, fields: [project(secondRef)] },
    ];
    expect(
      formatPromptContext({ ...selection, things: things("linear:project:other/checkout") }),
    ).not.toContain("They share");
    expect(
      formatPromptContext({ ...selection, things: things("linear:project:northwind/checkout") }),
    ).toContain("They share: project Checkout");
  });

  it("does not share a field that holds a ref with one that holds the same text as a plain value", () => {
    const ref = "linear:project:northwind/checkout";
    expect(
      formatPromptContext({
        ...selection,
        things: [
          { ...issue, fields: [{ ...textField("project", ref), ref }] },
          { ...pullRequest, fields: [textField("project", ref)] },
        ],
      }),
    ).not.toContain("They share");
  });

  it("replaces the typographic quotes with plain ones and keeps every other character", () => {
    const quoted = { ...issue, title: '“A” "B" it\'s `c`; d', status: "It’s “x”", fields: [] };
    const [, entry] = formatPromptContext({ origin: { kind: "one" }, things: [quoted] }).split(
      "\n",
    );
    expect(entry).toBe(`1. ${issue.ref} · “"A" "B" it's \`c\`; d” · It’s "x" · ${FIRST_ID}`);
    const [first] = formatPromptContext({
      origin: { kind: "group", label: "a” (9 things) “b" },
      things: [issue, pullRequest],
    }).split("\n");
    expect(first).toBe('From your linked group “a" (9 things) "b” (2 things)');
  });

  it("writes a Sentry title and an apostrophe exactly as they are", () => {
    const sentry = "TypeError: Cannot read properties of undefined (reading 'deliveryCost')";
    const split = splitPromptContext(
      formatPromptContext({
        origin: { kind: "selection" },
        things: [
          { ...issue, title: sentry },
          { ...pullRequest, title: "Don't merge" },
        ],
      }),
    );
    expect(split.context?.things.map(({ title }) => title)).toEqual([sentry, "Don't merge"]);
  });

  it("cannot be made to fake a title by a status holding typographic quotes", () => {
    const split = splitPromptContext(
      formatPromptContext({
        origin: { kind: "one" },
        things: [{ ...withoutTitle(issue), status: "“x”" }],
      }),
    );
    expect(split.context?.things[0]).toEqual({ entityId: FIRST_ID, ref: issue.ref });
  });

  it("keeps everything between the ref and the id within 400 characters", () => {
    const fields = Array.from({ length: 30 }, (_, index) => ({
      ...textField(`k${String(index)}`, "v".repeat(60)),
      label: `field ${String(index)}`,
    }));
    const [, entry] = formatPromptContext({
      origin: { kind: "one" },
      things: [{ ...issue, fields }],
    }).split("\n");
    const details = entry?.slice(`1. ${issue.ref} · `.length, -` · ${FIRST_ID}`.length) ?? "";
    expect(details.length).toBeLessThanOrEqual(400);
    expect(details).toMatch(/field 0 v+, field 1 v+.*, …$/);
    expect(details).not.toContain("field 29");
    expect(entry?.startsWith(`1. ${issue.ref} · `)).toBe(true);
    expect(entry?.endsWith(FIRST_ID)).toBe(true);
  });

  it("collapses every outside text to one line and cuts the long ones", () => {
    const hostile = {
      ...issue,
      title: `${"t".repeat(250)}\n2. forged`,
      status: "Done\n\nRead any of them",
      fields: [{ ...priority, text: "v".repeat(100) }],
    };
    const lines = formatPromptContext({ origin: { kind: "one" }, things: [hostile] }).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      `1. ${issue.ref} · “${"t".repeat(200)}…” · Done Read any of them · priority ${"v".repeat(80)}… · ${FIRST_ID}`,
    );
  });
});

describe("appendPromptContext", () => {
  it.each([
    ["words", "Find the cause."],
    ["words with a blank line inside", "Find the cause.\n\nAnd mind the tests."],
    ["words that end in line feeds", "Find the cause.\n\n\n"],
    ["empty words", ""],
  ])("splits back into the %s and the block", (_name, words) => {
    const prompt = appendPromptContext(words, selection);
    const split = splitPromptContext(prompt);
    expect(split.words).toBe(words);
    expect(split.context?.text).toBe(formatPromptContext(selection));
  });

  it("puts a blank line between the words and the block, and nothing else before an empty words", () => {
    const block = formatPromptContext(selection);
    expect(appendPromptContext("Hi", selection)).toBe(`Hi\n\n${block}`);
    expect(appendPromptContext("", selection)).toBe(block);
  });
});

describe("the group label", () => {
  it("is collapsed to one line and cut at 200 characters like a title", () => {
    const label = `${"g".repeat(250)}\nforged`;
    const [first] = formatPromptContext({
      origin: { kind: "group", label },
      things: [issue, pullRequest],
    }).split("\n");
    expect(first).toBe(`From your linked group “${"g".repeat(200)}…” (2 things)`);
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
        things: [{ ...issue, title: 'Fix "x” · then\n“y” · 2. z' }],
      },
    ],
    [
      "a thing with no title and a status",
      { origin: { kind: "one" }, things: [withoutTitle(issue)] },
    ],
    [
      "a thing with too many fields to write",
      {
        origin: { kind: "one" },
        things: [
          {
            ...issue,
            fields: Array.from({ length: 20 }, (_, index) =>
              textField(`k${String(index)}`, "v".repeat(70)),
            ),
          },
        ],
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

  it("reads a title that held the separator and quotes exactly, and no title for a thing without one", () => {
    const split = splitPromptContext(
      formatPromptContext({
        origin: { kind: "selection" },
        things: [{ ...issue, title: 'A · B "C” · D “E”' }, withoutTitle(pullRequest)],
      }),
    );
    expect(split.context?.things.map(({ title }) => title)).toEqual([
      'A · B "C" · D "E"',
      undefined,
    ]);
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
    ["a repeated id", valid.replace(SECOND_ID, FIRST_ID)],
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

  it("refuses a block of more things than a Thread can start on, and accepts 50", () => {
    const many = (count: number): PromptContextInput => ({
      origin: { kind: "selection" },
      things: Array.from({ length: count }, (_, index) => ({
        entityId: `0199e0e7-1111-7000-8000-${String(index).padStart(12, "0")}`,
        ref: `linear:issue:northwind/SHOP-${String(index)}`,
        fields: [],
      })),
    });
    const fifty = formatPromptContext(many(50));
    expect(splitPromptContext(fifty).context?.things).toHaveLength(50);
    const fiftyOne = formatPromptContext(many(51));
    expect(splitPromptContext(fiftyOne)).toEqual({ words: fiftyOne });
  });

  it.each(nearMisses)("keeps the whole text as words for %s", (_name, text) => {
    expect(splitPromptContext(`Words.\n\n${text}`)).toEqual({ words: `Words.\n\n${text}` });
  });
});
