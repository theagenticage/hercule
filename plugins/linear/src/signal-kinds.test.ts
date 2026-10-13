/**
 * Tests the signal kinds: the draft each `build` returns for the events the
 * feeds emit, that it passes the contract's block schemas the core checks,
 * and the declarations of each kind. Every payload here is first checked
 * against its event kind's schema, so a draft is only ever built from a
 * payload the host would accept. The CEL of the declarations is checked by
 * the controller when the plugin registers; here it is checked as data.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import type { SignalBuildContext, SignalDraft, StoredEvent } from "@hercule/plugin-host";
import { KnownBlock } from "@hercule/contract";
import { LINEAR_EVENT_KINDS, type IssueBlock } from "./kinds";
import { LINEAR_SIGNAL_KINDS } from "./signal-kinds";

const CONTEXT: SignalBuildContext = {
  connection: {
    id: "conn_1",
    config: {},
    accountId: "org-1:user-ada",
    displayName: "Acme · Ada Lovelace",
  },
  credentials: () => Effect.succeed({ apiKey: "unused" }),
};

const WORKSPACE = { id: "org-1", urlKey: "acme" };

const ADA = { id: "user-ada", name: "Ada Lovelace" };

const BO = { id: "user-bo", name: "Bo Diaz" };

/** Builds an invented issue, with `overrides` replacing any of its fields. */
const buildIssue = (overrides: Partial<IssueBlock> = {}): IssueBlock => ({
  id: "issue-1",
  identifier: "SHOP-123",
  title: "Checkout fails on an empty cart",
  url: "https://linear.app/acme/issue/SHOP-123/checkout-fails",
  state: { id: "state-1", name: "In Progress", type: "started" },
  priority: 2,
  priorityLabel: "High",
  assignee: ADA,
  labels: [
    { id: "label-2", name: "frontend" },
    { id: "label-1", name: "bug" },
  ],
  project: { id: "project-1", name: "Checkout" },
  projectMilestone: { id: "milestone-1", name: "Beta" },
  team: { id: "team-1", key: "SHOP", name: "Shop" },
  dueDate: "2026-10-20",
  estimate: 3,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-12T09:30:00.000Z",
  ...overrides,
});

/**
 * Decodes a payload against a kind's schema as the host does when an event is
 * emitted: a key the schema does not declare is an error.
 */
const decodeAsHost = (schema: Schema.Top, payload: unknown) =>
  Schema.decodeUnknownResult(schema as Schema.Codec<unknown>, { onExcessProperty: "error" })(
    payload,
  );

/**
 * Builds the stored event a feed would have written. Fails the test when the
 * payload does not pass its kind's schema.
 */
const buildStoredEvent = (
  kind: string,
  payload: Record<string, unknown>,
  envelope: { title: string; author: string | null; ref?: string; url?: string },
): StoredEvent => {
  const declaration = LINEAR_EVENT_KINDS[kind]!;
  expect(decodeAsHost(declaration.schema, payload)._tag, kind).toBe("Success");
  return {
    id: 7,
    kind,
    occurredAt: "2026-10-12T10:00:00.000Z",
    payload,
    refs: [envelope.ref ?? "linear:issue:org-1/issue-1"],
    url: envelope.url ?? "https://linear.app/acme/issue/SHOP-123/checkout-fails",
    title: envelope.title,
    author: envelope.author,
  };
};

/** Checks that a draft's blocks pass the contract's schemas. */
const expectDraftWithinContract = (draft: SignalDraft): void => {
  for (const block of draft.blocks) {
    expect(Schema.decodeUnknownResult(KnownBlock)(block)._tag, JSON.stringify(block)).toBe(
      "Success",
    );
  }
};

/** Builds the draft of the signal kind `word` for an event. */
const buildDraft = async (word: string, event: StoredEvent): Promise<SignalDraft> => {
  const kind = LINEAR_SIGNAL_KINDS.find((candidate) => candidate.word === word)!;
  const result = await Effect.runPromise(Effect.result(kind.build(event, CONTEXT)));
  if (Result.isFailure(result)) throw new Error(result.failure.message);
  return result.success;
};

/** Builds a `linear.issue.entered` event for an issue. */
const buildEnteredEvent = (issue: IssueBlock, description: string | null = "Steps to reproduce") =>
  buildStoredEvent(
    "linear.issue.entered",
    { workspace: WORKSPACE, issue, toYou: true, description },
    { title: `${issue.identifier} ${issue.title}`, author: null },
  );

describe("the issue signal", () => {
  it("titles the signal with the identifier and the title, and lays out the facts and the description", async () => {
    const draft = await buildDraft("issue", buildEnteredEvent(buildIssue()));

    expect(draft.title).toBe("SHOP-123 Checkout fails on an empty cart");
    expect(draft.place).toBe("acme/SHOP");
    expect(draft.priority).toBe("normal");
    expect(draft.actions).toEqual([]);
    expect(draft.blocks).toEqual([
      {
        type: "text",
        markdown: [
          "- Team: `Shop`",
          "- State: `In Progress`",
          "- Priority: `High`",
          "- Assigned to: `Ada Lovelace`",
          "- Project: `Checkout`",
          "- Milestone: `Beta`",
          "- Labels: `frontend`, `bug`",
          "- Due: `2026-10-20`",
          "- Estimate: `3`",
        ].join("\n"),
      },
      { type: "text", markdown: "Steps to reproduce" },
    ]);
    expectDraftWithinContract(draft);
  });

  it("is high priority when Linear marks the issue urgent", async () => {
    const draft = await buildDraft(
      "issue",
      buildEnteredEvent(buildIssue({ priority: 1, priorityLabel: "Urgent" })),
    );

    expect(draft.priority).toBe("high");
  });

  it("leaves out empty facts and an empty description", async () => {
    const issue = buildIssue({
      assignee: null,
      labels: [],
      project: null,
      projectMilestone: null,
      dueDate: null,
      estimate: null,
    });
    const draft = await buildDraft("issue", buildEnteredEvent(issue, null));

    expect(draft.blocks).toEqual([
      {
        type: "text",
        markdown: [
          "- Team: `Shop`",
          "- State: `In Progress`",
          "- Priority: `High`",
          "- Assigned to: nobody",
        ].join("\n"),
      },
    ]);
    expectDraftWithinContract(draft);
  });

  it("keeps hostile text from Linear inside its code span", async () => {
    const draft = await buildDraft(
      "issue",
      buildEnteredEvent(
        buildIssue({ state: { id: "s", name: "evil` **bold**\nnext", type: "started" } }),
      ),
    );

    expect((draft.blocks[0] as unknown as { markdown: string }).markdown).toContain(
      "- State: `evil' **bold** next`",
    );
  });
});

describe("the mention signal", () => {
  const COMMENT = {
    id: "comment-2",
    body: "@ada can you look at this?",
    url: "https://linear.app/acme/issue/SHOP-123#comment-2",
    createdAt: "2026-10-12T09:59:00.000Z",
    author: BO,
  };

  /** Builds a `linear.mentioned` event about the issue, with the fields of the mention. */
  const buildMentionEvent = (fields: Record<string, unknown>) =>
    buildStoredEvent(
      "linear.mentioned",
      {
        workspace: WORKSPACE,
        issue: buildIssue(),
        toYou: false,
        notificationId: "notification-1",
        type: "issueCommentMention",
        actor: BO,
        ...fields,
      },
      { title: "SHOP-123 Checkout fails on an empty cart", author: BO.name },
    );

  it("shows the comment it replies to, then the comment that mentions the user", async () => {
    const parent = {
      id: "comment-1",
      body: "The cart is empty here.",
      url: "https://linear.app/acme/issue/SHOP-123#comment-1",
      createdAt: "2026-10-12T09:00:00.000Z",
      author: null,
    };
    const draft = await buildDraft(
      "mention",
      buildMentionEvent({ comment: { ...COMMENT, parent } }),
    );

    expect(draft.title).toBe("SHOP-123 Checkout fails on an empty cart");
    expect(draft.asker).toBe("Bo Diaz");
    expect(draft.place).toBe("acme/SHOP");
    expect(draft.priority).toBe("normal");
    expect(draft.blocks).toEqual([
      {
        type: "messages",
        messages: [
          {
            author: { name: "Unknown" },
            at: parent.createdAt,
            text: parent.body,
            url: parent.url,
          },
          {
            author: { name: "Bo Diaz" },
            at: COMMENT.createdAt,
            text: COMMENT.body,
            url: COMMENT.url,
            mentionsYou: true,
          },
        ],
        omitted: 0,
      },
    ]);
    expectDraftWithinContract(draft);
  });

  it("shows the description for a mention in it, by the user who mentioned", async () => {
    const draft = await buildDraft(
      "mention",
      buildMentionEvent({
        type: "issueMention",
        comment: null,
        description: "Ask @ada about the totals.",
      }),
    );

    expect(draft.blocks).toEqual([
      {
        type: "messages",
        messages: [
          {
            author: { name: "Bo Diaz" },
            at: "2026-10-12T10:00:00.000Z",
            text: "Ask @ada about the totals.",
            url: "https://linear.app/acme/issue/SHOP-123/checkout-fails",
            mentionsYou: true,
          },
        ],
        omitted: 0,
      },
    ]);
    expectDraftWithinContract(draft);
  });

  it("titles a mention in a project with the project's title, in the workspace", async () => {
    const event = buildStoredEvent(
      "linear.mentioned",
      {
        workspace: WORKSPACE,
        subject: {
          type: "project",
          id: "project-1",
          title: "Checkout",
          url: "https://linear.app/acme/project/checkout",
        },
        notificationId: "notification-2",
        type: "projectCommentMention",
        actor: BO,
        comment: { ...COMMENT, parent: null },
      },
      { title: "Checkout", author: BO.name, ref: "linear:project:org-1/project-1" },
    );
    const draft = await buildDraft("mention", event);

    expect(draft.title).toBe("Checkout");
    expect(draft.place).toBe("acme");
    expect(draft.blocks).toHaveLength(1);
    expectDraftWithinContract(draft);
  });

  it("is normal priority even when the issue is urgent", async () => {
    const draft = await buildDraft(
      "mention",
      buildStoredEvent(
        "linear.mentioned",
        {
          workspace: WORKSPACE,
          issue: buildIssue({ priority: 1, priorityLabel: "Urgent" }),
          toYou: false,
          notificationId: "notification-1",
          type: "issueCommentMention",
          actor: BO,
          comment: { ...COMMENT, parent: null },
        },
        { title: "SHOP-123 Checkout fails on an empty cart", author: BO.name },
      ),
    );

    expect(draft.priority).toBe("normal");
  });
});

describe("the assigned signal", () => {
  /** Builds a `linear.assigned` event for an issue. */
  const buildAssignedEvent = (issue: IssueBlock, description: string | null) =>
    buildStoredEvent(
      "linear.assigned",
      {
        workspace: WORKSPACE,
        issue,
        toYou: true,
        notificationId: "notification-3",
        actor: BO,
        description,
        creator: ADA,
      },
      { title: `${issue.identifier} ${issue.title}`, author: BO.name },
    );

  it("shows the description by the issue's creator, then the facts", async () => {
    const draft = await buildDraft("assigned", buildAssignedEvent(buildIssue(), "Fix the totals."));

    expect(draft.title).toBe("SHOP-123 Checkout fails on an empty cart");
    expect(draft.asker).toBe("Bo Diaz");
    expect(draft.priority).toBe("normal");
    expect(draft.blocks[0]).toEqual({
      type: "messages",
      messages: [
        {
          author: { name: "Ada Lovelace" },
          at: "2026-10-01T08:00:00.000Z",
          text: "Fix the totals.",
          url: "https://linear.app/acme/issue/SHOP-123/checkout-fails",
        },
      ],
      omitted: 0,
    });
    expect(draft.blocks[1]).toMatchObject({ type: "text" });
    expectDraftWithinContract(draft);
  });

  it("leaves out an empty description, and is high priority when the issue is urgent", async () => {
    const draft = await buildDraft(
      "assigned",
      buildAssignedEvent(buildIssue({ priority: 1, priorityLabel: "Urgent" }), "  "),
    );

    expect(draft.priority).toBe("high");
    expect(draft.blocks.map((block) => block.type)).toEqual(["text"]);
  });
});

describe("the declarations of the signal kinds", () => {
  const findSignalKind = (word: string) => LINEAR_SIGNAL_KINDS.find((kind) => kind.word === word)!;

  it("raises a signal for every event, on the thread of its first ref", () => {
    for (const kind of LINEAR_SIGNAL_KINDS) {
      expect(kind.rule).toBe('"yes"');
      expect(kind.threadRef).toBe("event.refs[0]");
    }
    expect(
      LINEAR_SIGNAL_KINDS.map((kind) => [
        kind.word,
        kind.from,
        kind.priority,
        kind.namesYou,
        kind.matchFields.map((field) => field.name),
      ]),
    ).toEqual([
      [
        "issue",
        ["linear.issue.entered"],
        "normal",
        false,
        ["team", "project", "label", "assignee"],
      ],
      ["mention", ["linear.mentioned"], "normal", true, ["team", "author"]],
      ["assigned", ["linear.assigned"], "normal", true, ["team", "project", "author"]],
    ]);
  });

  it("withdraws on the events the spec names, and on nothing else", () => {
    for (const kind of LINEAR_SIGNAL_KINDS) {
      expect(kind.ends.every((end) => end.resolution === "withdrawn")).toBe(true);
    }
    expect(LINEAR_SIGNAL_KINDS.map((kind) => kind.ends.map((end) => end.eventKind))).toEqual([
      ["linear.issue.closed", "linear.issue.left"],
      ["linear.notification.archived", "linear.issue.closed"],
      ["linear.issue.unassigned", "linear.issue.closed"],
    ]);
  });

  it("names how an issue closed and why it left", () => {
    const readEndOutcome = (eventKind: string) =>
      findSignalKind("issue").ends.find((end) => end.eventKind === eventKind)!.outcome;

    for (const text of [
      "Done in Linear",
      "Canceled in Linear",
      "Marked duplicate in Linear",
      "Archived in Linear",
      "Deleted in Linear",
    ]) {
      expect(readEndOutcome("linear.issue.closed")).toContain(text);
    }
    for (const text of ["Assigned to ", "No longer matches this Connection's filters"]) {
      expect(readEndOutcome("linear.issue.left")).toContain(text);
    }
  });
});

describe("the event kinds", () => {
  it("are available to triage exactly as Intake's defaults say", () => {
    expect(
      Object.entries(LINEAR_EVENT_KINDS)
        .filter(([, declaration]) => declaration.availableToTriage)
        .map(([kind]) => kind),
    ).toEqual([
      "linear.issue.entered",
      "linear.issue.changed",
      "linear.mentioned",
      "linear.assigned",
    ]);
  });

  it("refuses a notification payload that carries neither an issue nor a subject", () => {
    const schema = LINEAR_EVENT_KINDS["linear.notification.archived"]!.schema;

    expect(decodeAsHost(schema, { workspace: WORKSPACE, notificationId: "n-1" })._tag).toBe(
      "Failure",
    );
  });
});
