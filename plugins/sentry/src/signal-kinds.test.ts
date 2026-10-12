/**
 * Tests the signal kinds: the draft each `build` returns for the events the
 * feed emits, that it passes the contract's block and action schemas the core
 * checks, and the ends of each kind. The CEL of the ends is checked by the
 * controller when the plugin registers; here the ends are checked as data.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import type { SignalBuildContext, SignalDraft, StoredEvent } from "@hercule/plugin-host";
import { BoundAction, KnownBlock } from "@hercule/contract";
import { buildIssueEvent } from "./ingest/events";
import { buildIssueBlock, ApiIssue } from "./sentry-objects";
import { SENTRY_SIGNAL_KINDS } from "./signal-kinds";
import {
  buildFakeIssue,
  renderFakeIssue,
  buildFakeWorld,
  TEST_ACCOUNT_ID,
  TEST_DISPLAY_NAME,
  TEST_ORGANIZATION,
  TEST_USER,
  stampAt,
  type FakeIssue,
} from "./testing";

const CONTEXT: SignalBuildContext = {
  connection: {
    id: "conn_1",
    config: {},
    accountId: TEST_ACCOUNT_ID,
    displayName: TEST_DISPLAY_NAME,
  },
  credentials: () => Effect.succeed({ token: "unused" }),
};

/** Builds the stored event the feed would have written for an issue. */
const buildStoredEvent = (
  kind: "entered" | "regressed" | "escalating",
  issue: FakeIssue,
  fields: Record<string, unknown> = {},
): StoredEvent => {
  // Read through the fake's rendering and the API schema, as the feed reads an issue.
  const block = buildIssueBlock(
    Schema.decodeUnknownSync(ApiIssue)(renderFakeIssue(buildFakeWorld([issue]), issue)),
  );
  const latest = issue.latestEvent;
  const event = buildIssueEvent({
    kind,
    organization: TEST_ORGANIZATION,
    issue: block,
    fields: {
      ...fields,
      ...(latest === null
        ? {}
        : {
            latestEvent: {
              id: latest.eventID,
              dateCreated: latest.dateCreated,
              ...(latest.environment === null ? {} : { environment: latest.environment }),
              ...(latest.release === null ? {} : { release: latest.release }),
              exception: { type: latest.type, value: latest.value, frames: latest.frames },
            },
          }),
    },
    dedupKey: `${issue.id}:${kind}:${issue.lastSeen}`,
    occurredAt: issue.lastSeen,
    fallbackTime: issue.lastSeen,
  });
  return {
    id: 7,
    kind: event.kind,
    occurredAt: event.occurredAt,
    payload: event.payload as Record<string, unknown>,
    refs: event.refs,
    url: event.url ?? null,
    title: event.title,
    author: event.author,
  };
};

/** Checks that a draft's blocks and actions pass the contract's schemas. */
const expectDraftWithinContract = (draft: SignalDraft): void => {
  for (const block of draft.blocks) {
    expect(Schema.decodeUnknownResult(KnownBlock)(block)._tag, JSON.stringify(block)).toBe(
      "Success",
    );
  }
  const DraftActionFields = Schema.Struct({
    id: BoundAction.fields.id,
    label: BoundAction.fields.label,
    primary: BoundAction.fields.primary,
    field: BoundAction.fields.field,
  });
  for (const action of draft.actions) {
    const { id, label, primary, field } = action;
    expect(
      Schema.decodeUnknownResult(DraftActionFields)({
        id,
        label,
        ...(primary === undefined ? {} : { primary }),
        ...(field === undefined ? {} : { field }),
      })._tag,
    ).toBe("Success");
  }
};

/** Returns the facts block and the stack trace block of a draft, which are text blocks. */
const readMarkdown = (draft: SignalDraft): [{ markdown: string }, { markdown: string }] =>
  draft.blocks as unknown as [{ markdown: string }, { markdown: string }];

/** Builds the draft of the signal kind `word` for an event. */
const buildDraft = async (word: string, event: StoredEvent): Promise<SignalDraft> => {
  const kind = SENTRY_SIGNAL_KINDS.find((candidate) => candidate.word === word)!;
  const result = await Effect.runPromise(Effect.result(kind.build(event, CONTEXT)));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

const FRAMES = [
  { filename: "app/checkout.ts", function: "submitOrder", lineNo: 42, inApp: true },
  { filename: "app/server.ts", function: "handle", lineNo: 7, inApp: true },
];

const withEvent = (overrides: Partial<FakeIssue> = {}): FakeIssue =>
  buildFakeIssue("1001", {
    lastSeen: stampAt(-1),
    latestEvent: {
      eventID: "e1",
      dateCreated: stampAt(-1),
      release: "webshop@2.4.0",
      environment: "production",
      frames: FRAMES,
      type: "TypeError",
      value: "cannot read properties of undefined",
    },
    ...overrides,
  });

describe("the issue signal", () => {
  it("titles the signal with the short id and the title, and lays out the facts and the stack trace", async () => {
    const issue = withEvent();
    const draft = await buildDraft("issue", buildStoredEvent("entered", issue, { toYou: false }));

    expect(draft.title).toBe(`WEBSHOP-1001 ${issue.title}`);
    expect(draft.place).toBe("acme/webshop");
    expect(draft.priority).toBe("normal");
    expect(draft.blocks).toHaveLength(2);
    const [facts, trace] = readMarkdown(draft);
    expect(facts.markdown).toContain("- Project: `webshop`");
    expect(facts.markdown).toContain("- Release: `webshop@2.4.0`");
    // The innermost call comes first, as a JavaScript stack trace lists it.
    expect(trace.markdown).toBe(
      [
        "```",
        "TypeError: cannot read properties of undefined",
        "  at handle (app/server.ts:7)",
        "  at submitOrder (app/checkout.ts:42)",
        "```",
      ].join("\n"),
    );
    expectDraftWithinContract(draft);
  });

  it("is high priority when Sentry says the issue is", async () => {
    const draft = await buildDraft(
      "issue",
      buildStoredEvent("entered", withEvent({ priority: "high" })),
    );

    expect(draft.priority).toBe("high");
  });

  it("leaves out the stack trace when the issue has no event", async () => {
    const draft = await buildDraft(
      "issue",
      buildStoredEvent("entered", withEvent({ latestEvent: null })),
    );

    expect(draft.blocks).toHaveLength(1);
  });

  it("offers resolve, archive and assign to me, none of them primary", async () => {
    const draft = await buildDraft("issue", buildStoredEvent("entered", withEvent()));

    expect(draft.actions.map((action) => [action.id, action.action, action.label])).toEqual([
      ["resolve", "issue.resolve", "Resolve"],
      ["archive", "issue.archive", "Archive until it escalates"],
      ["assign", "issue.assign", "Assign to me"],
    ]);
    expect(draft.actions.some((action) => action.primary === true)).toBe(false);
    expect(draft.actions[0]?.input).toEqual({
      orgSlug: "acme",
      issueId: "1001",
      shortId: "WEBSHOP-1001",
      projectSlug: "webshop",
    });
    expect(draft.actions[1]?.input).toMatchObject({ until: "escalating" });
    expect(draft.actions[2]?.input).toMatchObject({
      assignee: { type: "user", id: TEST_USER.id, name: TEST_USER.username },
    });
  });

  it("leaves out assign to me when the issue is already the user's", async () => {
    const draft = await buildDraft(
      "issue",
      buildStoredEvent(
        "entered",
        withEvent({ assignedTo: { type: "user", id: TEST_USER.id, name: "ada" } }),
      ),
    );

    expect(draft.actions.map((action) => action.id)).toEqual(["resolve", "archive"]);
  });

  it("still offers assign to me when the issue is a team's", async () => {
    const draft = await buildDraft(
      "issue",
      buildStoredEvent(
        "entered",
        withEvent({ assignedTo: { type: "team", id: "31", name: "platform" } }),
      ),
    );

    expect(draft.actions.map((action) => action.id)).toContain("assign");
  });

  it("keeps hostile text from Sentry inside its code span and fence", async () => {
    const draft = await buildDraft(
      "issue",
      buildStoredEvent(
        "entered",
        withEvent({
          culprit: "evil` **bold**\nnext line",
          latestEvent: {
            eventID: "e1",
            dateCreated: stampAt(-1),
            release: null,
            environment: null,
            frames: [],
            type: "Error",
            value: "```\nbreak out",
          },
        }),
      ),
    );

    const [facts, trace] = readMarkdown(draft);
    expect(facts.markdown).toContain("- Culprit: `evil' **bold** next line`");
    expect(trace.markdown.startsWith("````\n")).toBe(true);
    expect(trace.markdown.endsWith("\n````")).toBe(true);
  });
});

describe("the regressed signal", () => {
  it("opens with the release the issue came back in, and is high priority", async () => {
    const draft = await buildDraft(
      "regressed",
      buildStoredEvent("regressed", withEvent(), { after: "resolved", release: "webshop@2.5.0" }),
    );

    expect(draft.priority).toBe("high");
    expect(draft.blocks[0]).toEqual({
      type: "text",
      markdown: "Came back in `webshop@2.5.0` after it was resolved",
    });
    expectDraftWithinContract(draft);
  });

  it("opens with the previous state alone when the release is unknown", async () => {
    const draft = await buildDraft(
      "regressed",
      buildStoredEvent("regressed", withEvent(), { after: "archived" }),
    );

    expect(draft.blocks[0]).toEqual({ type: "text", markdown: "Came back after it was archived" });
  });
});

describe("the escalating signal", () => {
  it("opens with the event count, and is high priority", async () => {
    const draft = await buildDraft(
      "escalating",
      buildStoredEvent("escalating", withEvent({ count: "430" })),
    );

    expect(draft.priority).toBe("high");
    expect(draft.blocks[0]).toEqual({ type: "text", markdown: "Escalating: `430` events" });
    expectDraftWithinContract(draft);
  });
});

describe("the declarations of the signal kinds", () => {
  const find = (word: string) => SENTRY_SIGNAL_KINDS.find((kind) => kind.word === word)!;

  it("raises a signal for every event, on the issue's own thread", () => {
    for (const kind of SENTRY_SIGNAL_KINDS) {
      expect(kind.rule).toBe('"yes"');
      expect(kind.threadRef).toBe("event.refs[0]");
      expect(kind.namesYou).toBe(false);
      expect(kind.matchFields.map((field) => field.name)).toEqual([
        "project",
        "level",
        "errorType",
        "assignee",
      ]);
    }
    expect(SENTRY_SIGNAL_KINDS.map((kind) => [kind.word, kind.from, kind.priority])).toEqual([
      ["issue", ["sentry.issue.entered"], "normal"],
      ["regressed", ["sentry.issue.regressed"], "high"],
      ["escalating", ["sentry.issue.escalating"], "high"],
    ]);
  });

  it("is decided only when the user did the resolving or archiving, with the matching answer", () => {
    for (const kind of SENTRY_SIGNAL_KINDS) {
      expect(
        kind.ends
          .filter((end) => end.resolution === "decided")
          .map((end) => [end.eventKind, end.condition, end.actionId]),
      ).toEqual([
        ["sentry.issue.resolved", "event.payload.byYou", "resolve"],
        ["sentry.issue.archived", "event.payload.byYou", "archive"],
      ]);
    }
  });

  it("withdraws on somebody else's resolving or archiving, and on leaving", () => {
    for (const kind of SENTRY_SIGNAL_KINDS) {
      const withdrawn = kind.ends.filter((end) => end.resolution === "withdrawn");
      expect(withdrawn.map((end) => [end.eventKind, end.condition])).toEqual(
        expect.arrayContaining([
          ["sentry.issue.resolved", "!event.payload.byYou"],
          ["sentry.issue.archived", "!event.payload.byYou"],
          ["sentry.issue.left", undefined],
        ]),
      );
    }
  });

  it("is ended by the newer signal about the same issue", () => {
    const newerKinds = (word: string) =>
      find(word)
        .ends.filter((end) => end.outcome.includes("newer signal"))
        .map((end) => [end.eventKind, end.outcome]);

    expect(newerKinds("issue")).toEqual([
      ["sentry.issue.escalating", '"Escalating, see the newer signal"'],
      ["sentry.issue.regressed", '"Came back, see the newer signal"'],
    ]);
    expect(newerKinds("regressed")).toEqual([
      ["sentry.issue.escalating", '"Escalating, see the newer signal"'],
    ]);
    expect(newerKinds("escalating")).toEqual([
      ["sentry.issue.regressed", '"Came back, see the newer signal"'],
    ]);
  });

  it("explains why an issue left", () => {
    const outcome = find("issue").ends.find(
      (end) => end.eventKind === "sentry.issue.left",
    )!.outcome;

    for (const text of [
      "Assigned to ",
      "No longer matches this Connection's filters",
      "No events in ",
      "Deleted or merged in Sentry",
    ]) {
      expect(outcome).toContain(text);
    }
  });
});
