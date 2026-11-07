/**
 * Tests how a kind's declaration and one observation become the slots stored
 * on an entity row. The GitHub declarations repeat the plugin's real table,
 * and the Quayside ones are an invented plugin with money and date facts, a
 * kind with no person and a kind with no status.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { QualifiedEntityKindDeclaration } from "@hercule/plugin-host";
import { renderEntitySlots, type FullEntityObservation } from "./slots";

const PULL_REQUEST: QualifiedEntityKindDeclaration = {
  word: "github/pull-request",
  home: "github/repository",
  card: "compact",
  noun: "Pull request",
  refPrefix: "github:pr:",
  pace: "fast",
  patience: 24,
  identifier: "#{number}",
  person: "author",
  owner: "author",
  status: {
    open: { shape: "fork", tone: "quiet", word: "Open", norm: true, stage: "in-review" },
    changes: { shape: "hold", tone: "attention", word: "Changes requested", stage: "in-review" },
  },
  facts: [
    { field: "diff", form: "delta" },
    { field: "files", form: "count", unit: "file" },
  ],
  reasons: {
    "review-requested": { say: "{person} asked for your review", tone: "plain" },
    waiting: { say: "With reviewers", tone: "plain" },
  },
};

const ISSUE: QualifiedEntityKindDeclaration = {
  word: "github/issue",
  home: "github/repository",
  noun: "Issue",
  refPrefix: "github:issue:",
  pace: "slow",
  patience: 336,
  identifier: "#{number}",
  person: "assignee",
  owner: "assignee",
  status: { open: { shape: "ring", tone: "quiet", word: "Open", norm: true } },
  facts: [{ field: "labels", form: "word" }],
  reasons: { assigned: { say: "Assigned to you", tone: "plain" } },
};

const REPOSITORY: QualifiedEntityKindDeclaration = {
  word: "github/repository",
  noun: "Repository",
  refPrefix: "github:repo:",
  pace: "context",
  patience: 0,
  identifier: "{name}",
  person: null,
  owner: null,
  groupable: { caption: "GitHub repository" },
  status: null,
  facts: [],
  reasons: {},
};

/** An invented kind: no person, and one fact in each of three forms. */
const PURCHASE_ORDER: QualifiedEntityKindDeclaration = {
  word: "quayside/purchase-order",
  noun: "Purchase order",
  refPrefix: "quayside:po:",
  pace: "slow",
  patience: 120,
  identifier: "{key}",
  person: null,
  owner: "assignee",
  status: { waiting: { shape: "ring", tone: "quiet", word: "Sign-off" } },
  facts: [
    { field: "amount", form: "money" },
    { field: "due", form: "date" },
    { field: "urgency", form: "bars" },
  ],
  reasons: { delayed: { say: "Delivery moved to {value}", tone: "attention" } },
};

/** An invented kind with no status table at all. */
const NOTE: QualifiedEntityKindDeclaration = {
  word: "quayside/note",
  noun: "Note",
  refPrefix: "quayside:note:",
  pace: "slow",
  patience: 48,
  identifier: "N-{key}",
  person: "writer",
  owner: null,
  status: null,
  facts: [],
  reasons: {},
};

/** Builds a full observation of `kind` with the given fields and the keys the test changes. */
const observe = (
  kind: string,
  fields: FullEntityObservation["fields"],
  rest: Partial<FullEntityObservation> = {},
): FullEntityObservation => ({
  kind,
  ref: `ref:${kind}:1`,
  title: "A title",
  fields,
  concerns: [],
  sourceUpdatedAt: "2026-11-01T10:00:00.000Z",
  ...rest,
});

const PULL_REQUEST_FIELDS = { number: 87, author: "mei-tanaka", diff: "+120 -30", files: 4 };

describe("renderEntitySlots renders", () => {
  const cases: ReadonlyArray<{
    name: string;
    declaration: QualifiedEntityKindDeclaration;
    observation: FullEntityObservation;
    expected: unknown;
  }> = [
    {
      name: "a pull request: template, person, owner, status, facts and a reason with the person's name",
      declaration: PULL_REQUEST,
      observation: observe("pull-request", PULL_REQUEST_FIELDS, {
        status: "changes",
        reason: "review-requested",
      }),
      expected: {
        noun: "Pull request",
        card: "compact",
        pace: "fast",
        patience: 24,
        home: "github/repository",
        identifier: "#87",
        person: { name: "mei-tanaka" },
        owner: "mei-tanaka",
        status: { shape: "hold", tone: "attention", label: "Changes requested" },
        facts: [
          { form: "delta", added: 120, removed: 30 },
          { form: "count", value: 4, unit: "file" },
        ],
        reason: { say: "mei-tanaka asked for your review", tone: "plain" },
      },
    },
    {
      name: "an issue: no card in the declaration means rich, the home and the norm of its status are copied, an unassigned issue has no person or owner, an empty fact is left out",
      declaration: ISSUE,
      observation: observe(
        "issue",
        { number: "12", assignee: null, labels: "" },
        { status: "open" },
      ),
      expected: {
        noun: "Issue",
        card: "rich",
        pace: "slow",
        patience: 336,
        home: "github/repository",
        identifier: "#12",
        status: { shape: "ring", tone: "quiet", label: "Open", norm: true },
        facts: [],
      },
    },
    {
      name: "a kind with no person: money, date and bars facts, the owner, and a reason filled from another field",
      declaration: PURCHASE_ORDER,
      observation: observe(
        "purchase-order",
        {
          key: "PO-9",
          assignee: "juno-park",
          amount: "EUR 1,200.00",
          due: "2026-12-03T00:00:00.000Z",
          urgency: 2,
          value: "5 Dec",
        },
        { status: "waiting", reason: "delayed" },
      ),
      expected: {
        noun: "Purchase order",
        card: "rich",
        pace: "slow",
        patience: 120,
        identifier: "PO-9",
        owner: "juno-park",
        status: { shape: "ring", tone: "quiet", label: "Sign-off" },
        facts: [
          { form: "money", text: "EUR 1,200.00" },
          { form: "date", on: "2026-12-03T00:00:00.000Z" },
          { form: "bars", level: 2 },
        ],
        reason: { say: "Delivery moved to 5 Dec", tone: "attention" },
      },
    },
    {
      name: "a kind with no status table: the person is kept and there is no status",
      declaration: NOTE,
      observation: observe("note", { key: "3", writer: "ines-carvalho" }),
      expected: {
        noun: "Note",
        card: "rich",
        pace: "slow",
        patience: 48,
        identifier: "N-3",
        person: { name: "ines-carvalho" },
        facts: [],
      },
    },
    {
      name: "a place: noun and caption only",
      declaration: REPOSITORY,
      observation: observe("repository", { name: "storefront-web" }),
      expected: { noun: "Repository", pace: "context", caption: "GitHub repository" },
    },
  ];

  it.each(cases)("$name", async ({ declaration, observation, expected }) => {
    const slots = await Effect.runPromise(renderEntitySlots(declaration, observation));
    expect(slots).toEqual(expected);
  });
});

describe("renderEntitySlots refuses", () => {
  const cases: ReadonlyArray<{
    name: string;
    declaration: QualifiedEntityKindDeclaration;
    observation: FullEntityObservation;
    message: string[];
  }> = [
    {
      name: "a template that names a missing field",
      declaration: PULL_REQUEST,
      observation: observe("pull-request", { author: "mei-tanaka" }),
      message: ["github/pull-request", "ref:pull-request:1", "identifier", "#{number}", '"number"'],
    },
    {
      name: "a reason that needs a person the thing does not have",
      declaration: PULL_REQUEST,
      observation: observe(
        "pull-request",
        { number: 87, author: null },
        { reason: "review-requested" },
      ),
      message: ["github/pull-request", "review-requested", '"person"'],
    },
    {
      name: "a status key that is not in the table",
      declaration: PULL_REQUEST,
      observation: observe("pull-request", PULL_REQUEST_FIELDS, { status: "stuck" }),
      message: ["github/pull-request", '"stuck"', "status"],
    },
    {
      name: "a status key on a kind with no status",
      declaration: NOTE,
      observation: observe("note", { key: "3" }, { status: "open" }),
      message: ["quayside/note", '"open"', "status"],
    },
    {
      name: "a reason key that is not declared",
      declaration: PULL_REQUEST,
      observation: observe("pull-request", PULL_REQUEST_FIELDS, { reason: "vanished" }),
      message: ["github/pull-request", '"vanished"', "reason"],
    },
    {
      name: "a delta fact that is not written as +added -removed",
      declaration: PULL_REQUEST,
      observation: observe("pull-request", { ...PULL_REQUEST_FIELDS, diff: "many" }),
      message: ["github/pull-request", '"diff"', "delta"],
    },
    {
      name: "bars outside 1 to 3",
      declaration: PURCHASE_ORDER,
      observation: observe("purchase-order", { key: "PO-9", urgency: 7 }),
      message: ["quayside/purchase-order", "out of bounds"],
    },
    {
      name: "an identifier longer than the contract allows",
      declaration: PULL_REQUEST,
      observation: observe("pull-request", { ...PULL_REQUEST_FIELDS, number: "9".repeat(80) }),
      message: ["github/pull-request", "out of bounds", "identifier"],
    },
  ];

  it.each(cases)("$name", async ({ declaration, observation, message }) => {
    const error = await Effect.runPromise(Effect.flip(renderEntitySlots(declaration, observation)));
    expect(error._tag).toBe("PluginError");
    for (const part of message) expect(error.message).toContain(part);
  });
});
