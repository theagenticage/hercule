/**
 * Tests the claim rules of the input repository:
 *
 * - `markDelivered`, `requeue` and `cancelWithReason` each change a row only
 *   while it still holds the claim of the send being answered;
 * - `claim` never claims an input of a session that has exited;
 * - `claimOldestUnlessOneIsOnTheWire` claims one input of an idle session at a time;
 * - an agent step's prompt marked `sent` is never sent again, and only a late
 *   confirmation changes it, to `delivered`;
 * - a Discussion Input is sent after every other waiting input, and a held
 *   one is skipped by every path that opens a turn.
 *
 * The case they guard against: an input is sent, the send is given up and
 * the row goes back to waiting, and the row is sent again. A late answer
 * about the first send carries the first claim's time, and must leave the
 * second send alone.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { mintUuid, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import type { DiscussionMentions } from "./discussion-input";
import { inputRepository, type StoredInput } from "./inputs";
import { sessionRepository } from "./repository";

const at = "2026-09-07T10:00:00.000Z";

/** When the first send claimed the row. */
const FIRST_SEND = "2026-09-07T10:01:00.000Z";

/** When the row was sent again, after the first send's claim was released. */
const SECOND_SEND = "2026-09-07T10:02:00.000Z";

/** Returns a new canonical v7 id, the only id format the database accepts. */
const mintId = () => uuidToString(mintUuid());

/** Writes a queued session with one waiting input. Returns both ids. */
const insertSessionWithInput = Effect.gen(function* () {
  const sessions = yield* sessionRepository;
  const inputs = yield* inputRepository;
  const sessionId = mintId();
  yield* sessions.insert({
    id: sessionId,
    title: "a session",
    permissionProfileId: mintId(),
    agentId: undefined,
    conversationId: undefined,
    step: undefined,
    instanceId: mintId(),
    runnerId: mintId(),
    requestedAccessMode: "approval-required",
    accessMode: "approval-required",
    workspaceId: null,
    projectId: undefined,
    checkoutBranch: undefined,
    githubConnectionId: undefined,
    spec: "{}",
    modelSelection: { model: "clever", options: {} },
    parentSessionId: undefined,
    createdBy: "user",
    at,
  });
  const input = yield* inputs.insert({
    sessionId,
    source: "user",
    actor: "user",
    text: "are you there?",
    at,
  });
  return { sessionId, inputId: input.id };
});

/**
 * Writes a session and one input for it, sends the input, puts it back to
 * waiting the way a failed send does, and sends it again. Returns both ids.
 */
const arrangeInputSentTwice = Effect.gen(function* () {
  const inputs = yield* inputRepository;
  const { sessionId, inputId } = yield* insertSessionWithInput;
  yield* inputs.claim(inputId, FIRST_SEND);
  yield* inputs.requeue(inputId, FIRST_SEND, "the runner did not answer in time");
  yield* inputs.claim(inputId, SECOND_SEND);
  return { sessionId, inputId };
});

/**
 * Arranges an input sent twice, runs `answer` with the input's id as the
 * late answer to the first send, and returns the row as it is afterwards.
 */
const answerFirstSend = (
  answer: (
    inputs: Effect.Success<typeof inputRepository>,
    inputId: string,
  ) => Effect.Effect<void, unknown>,
): Promise<StoredInput> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const inputs = yield* inputRepository;
      const { sessionId, inputId } = yield* arrangeInputSentTwice;
      yield* answer(inputs, inputId);
      const row = yield* inputs.one(sessionId, inputId);
      if (Option.isNone(row)) return yield* Effect.die("the input was just written");
      return row.value;
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
  );

/** The row as the second send left it, which a late answer to the first send must not change. */
const SENT_AGAIN = { status: "queued", sentAt: SECOND_SEND, reason: null, delivery: null };

describe("a late answer to a send that was released and sent again", () => {
  it("does not mark the input delivered", async () => {
    const row = await answerFirstSend((inputs, id) =>
      inputs.markDelivered(id, FIRST_SEND, "steered", at),
    );

    expect(row).toMatchObject(SENT_AGAIN);
  });

  it("does not put the input back to waiting", async () => {
    const row = await answerFirstSend((inputs, id) =>
      inputs.requeue(id, FIRST_SEND, "the harness refused it"),
    );

    expect(row).toMatchObject(SENT_AGAIN);
  });

  it("does not cancel the input", async () => {
    const row = await answerFirstSend((inputs, id) =>
      inputs.cancelWithReason(id, FIRST_SEND, "the session exited"),
    );

    expect(row).toMatchObject(SENT_AGAIN);
  });
});

// Without these cases, the three above would also pass if the writes never
// changed anything.
describe("an answer to the send that holds the row", () => {
  it("marks the input delivered", async () => {
    const row = await answerFirstSend((inputs, id) =>
      inputs.markDelivered(id, SECOND_SEND, "steered", at),
    );

    expect(row).toMatchObject({ status: "delivered", sentAt: null, delivery: "steered" });
  });

  it("puts the input back to waiting, with the reason", async () => {
    const row = await answerFirstSend((inputs, id) =>
      inputs.requeue(id, SECOND_SEND, "the harness refused it"),
    );

    expect(row).toMatchObject({
      status: "queued",
      sentAt: null,
      reason: "the harness refused it",
      delivery: null,
    });
  });

  it("cancels the input, with the reason", async () => {
    const row = await answerFirstSend((inputs, id) =>
      inputs.cancelWithReason(id, SECOND_SEND, "the session exited"),
    );

    expect(row).toMatchObject({ status: "cancelled", sentAt: null, reason: "the session exited" });
  });
});

describe("claiming an input", () => {
  it("claims nothing once the session has exited, and leaves the input waiting", async () => {
    // A claim decided before an exit can land after it. The input then stays
    // queued, and the resume that follows the exit sends it.
    const { claimed, row } = await Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const inputs = yield* inputRepository;
        const { sessionId, inputId } = yield* insertSessionWithInput;
        yield* sessions.moved(sessionId, "exited", at);
        const claimed = yield* inputs.claim(inputId, FIRST_SEND);
        return { claimed, row: yield* inputs.one(sessionId, inputId) };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(claimed).toEqual(Option.none());
    expect(Option.map(row, (one) => ({ status: one.status, sentAt: one.sentAt }))).toEqual(
      Option.some({ status: "queued", sentAt: null }),
    );
  });

  it("claims the input of a session that has not exited", async () => {
    const claimed = await Effect.runPromise(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const { inputId } = yield* insertSessionWithInput;
        return yield* inputs.claim(inputId, FIRST_SEND);
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(Option.map(claimed, (one) => one.sentAt)).toEqual(Option.some(FIRST_SEND));
  });
});

describe("claiming the oldest waiting input unless one is on the wire", () => {
  /**
   * Writes an idle session with two waiting inputs, runs `arrange` on it, then
   * claims the oldest input twice, the way the change to idle and a delivery
   * pass both can. Returns the texts of the rows each claim got.
   */
  const claimOldestTwice = (
    arrange: (sessionId: string) => Effect.Effect<void, unknown, SqlClient.SqlClient>,
  ): Promise<ReadonlyArray<string | undefined>> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sessions = yield* sessionRepository;
        const inputs = yield* inputRepository;
        const { sessionId } = yield* insertSessionWithInput;
        yield* inputs.insert({ sessionId, source: "user", actor: "user", text: "later", at });
        yield* sessions.moved(sessionId, "idle", at);
        yield* arrange(sessionId);
        const first = yield* inputs.claimOldestUnlessOneIsOnTheWire(sessionId, FIRST_SEND);
        const second = yield* inputs.claimOldestUnlessOneIsOnTheWire(sessionId, SECOND_SEND);
        return [first, second].map((one) =>
          Option.getOrUndefined(Option.map(one, (row) => row.text)),
        );
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

  it("claims the oldest input of an idle session, and nothing more while it is unanswered", async () => {
    // The runner takes one input per turn, so the newer input waits until the
    // runner answers for the older one.
    expect(await claimOldestTwice(() => Effect.void)).toEqual(["are you there?", undefined]);
  });

  it("claims nothing once the session is no longer idle", async () => {
    const claimed = await claimOldestTwice((sessionId) =>
      Effect.flatMap(sessionRepository, (sessions) => sessions.moved(sessionId, "busy", at)),
    );

    expect(claimed).toEqual([undefined, undefined]);
  });
});

describe("an agent step's prompt the runner never answered", () => {
  /**
   * Writes a session with one step prompt, sends it, and marks it `sent` the
   * way a send that got no answer does. Runs `answer` with the prompt's id as
   * the runner's late answer, and returns whether the prompt was marked
   * `sent` and the row as it is afterwards.
   */
  const answerSentPrompt = (
    answer: (
      inputs: Effect.Success<typeof inputRepository>,
      inputId: string,
    ) => Effect.Effect<unknown, unknown>,
  ): Promise<{ readonly marked: boolean; readonly row: StoredInput }> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const { sessionId } = yield* insertSessionWithInput;
        const prompt = yield* inputs.insert({
          sessionId,
          source: "user",
          actor: "run",
          text: "implement the change",
          at,
          stepIteration: 1,
        });
        yield* inputs.claim(prompt.id, FIRST_SEND);
        const marked = yield* inputs.markSent(prompt.id, FIRST_SEND);
        yield* answer(inputs, prompt.id);
        const row = yield* inputs.one(sessionId, prompt.id);
        if (Option.isNone(row)) return yield* Effect.die("the input was just written");
        return { marked, row: row.value };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

  it("is marked sent, and keeps when it was sent", async () => {
    const { marked, row } = await answerSentPrompt(() => Effect.void);

    expect(marked).toBe(true);
    expect(row).toMatchObject({ status: "sent", sentAt: FIRST_SEND, reason: null });
  });

  it("is marked delivered by a late confirmation", async () => {
    // The runner took the prompt after all, so the row says so.
    const { row } = await answerSentPrompt((inputs, id) =>
      inputs.markDelivered(id, FIRST_SEND, "opened", at),
    );

    expect(row).toMatchObject({ status: "delivered", delivery: "opened", sentAt: null });
  });

  it("is never claimed, put back to waiting or cancelled", async () => {
    // A sent prompt is never sent again: the runner's answer about the step
    // settles the step.
    const { row } = await answerSentPrompt((inputs, id) =>
      Effect.gen(function* () {
        yield* inputs.requeue(id, FIRST_SEND, "the harness refused it");
        yield* inputs.cancelWithReason(id, FIRST_SEND, "the session exited");
        yield* inputs.claim(id, SECOND_SEND);
      }),
    );

    expect(row).toMatchObject({ status: "sent", sentAt: FIRST_SEND, reason: null });
  });
});

/** A Discussion Input that holds an entry, which may open a turn on an idle session. */
const ENTRY_MENTIONS: DiscussionMentions = {
  entries: [
    {
      discussionId: mintId(),
      repository: "github.com/acme/app",
      files: [{ path: "a.ts", sessions: [{ sessionId: mintId(), canBeTold: true }] }],
    },
  ],
  newPosts: [],
};

/** A Discussion Input that holds only mentions of new Posts, which never opens a turn. */
const NEW_POSTS_MENTIONS: DiscussionMentions = {
  entries: [],
  newPosts: [{ discussionId: mintId(), firstPostId: mintId() }],
};

/**
 * Writes a session in `status`, started by an agent step when `stepSession`
 * is set, with these inputs, in order, a minute apart. A Discussion Input is
 * written first, so it is older than every other input. Returns the session's
 * id and the inputs.
 */
const arrangeWaitingInputs = (
  status: "queued" | "idle",
  mentions: DiscussionMentions,
  options: { readonly userInput?: true; readonly stepSession?: true } = {},
) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const inputs = yield* inputRepository;
    const sessionId = mintId();
    yield* sessions.insert({
      id: sessionId,
      title: "a session",
      permissionProfileId: mintId(),
      agentId: options.stepSession === true ? mintId() : undefined,
      conversationId: undefined,
      step: options.stepSession === true ? { runId: mintId(), stepId: "build" } : undefined,
      instanceId: mintId(),
      runnerId: mintId(),
      requestedAccessMode: "approval-required",
      accessMode: "approval-required",
      workspaceId: null,
      projectId: undefined,
      checkoutBranch: undefined,
      githubConnectionId: undefined,
      spec: "{}",
      modelSelection: { model: "clever", options: {} },
      parentSessionId: undefined,
      createdBy: "user",
      at,
    });
    if (status === "idle") yield* sessions.moved(sessionId, "idle", at);
    const discussion = yield* inputs.insert({
      sessionId,
      source: "discussion",
      actor: "system",
      text: "about discussions",
      at: FIRST_SEND,
      discussionMentions: mentions,
    });
    const user =
      options.userInput === true
        ? yield* inputs.insert({
            sessionId,
            source: "user",
            actor: "user",
            text: "next, please",
            at: SECOND_SEND,
          })
        : undefined;
    return { sessionId, discussion, user };
  });

/** Runs `body` against a fresh database, failing the test on any error. */
const runOnTestDatabase = <A>(body: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(body.pipe(Effect.provide(TestDatabase), Effect.orDie));

describe("the order in which a session's waiting inputs are sent", () => {
  it("sends a Discussion Input at a turn's end after a younger input of another source", async () => {
    const found = await runOnTestDatabase(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const { sessionId, discussion, user } = yield* arrangeWaitingInputs(
          "idle",
          NEW_POSTS_MENTIONS,
          { userInput: true },
        );
        const first = Option.getOrThrow(yield* inputs.findNextWaiting(sessionId)).id;
        yield* inputs.cancel(user!.id);
        const second = Option.getOrThrow(yield* inputs.findNextWaiting(sessionId)).id;
        return { first, second, expected: [user!.id, discussion.id] };
      }),
    );
    expect([found.first, found.second]).toEqual(found.expected);
  });

  it("opens a turn on an idle session with another input before a Discussion Input", async () => {
    const [claimed, user] = await runOnTestDatabase(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const { sessionId, user } = yield* arrangeWaitingInputs("idle", ENTRY_MENTIONS, {
          userInput: true,
        });
        const row = yield* inputs.claimOldestUnlessOneIsOnTheWire(sessionId, SECOND_SEND);
        return [Option.getOrThrow(row).id, user!.id];
      }),
    );
    expect(claimed).toBe(user);
  });
});

describe("a held Discussion Input, where no turn runs", () => {
  /** Checks what the paths that open a turn see of the session's one Discussion Input. */
  const inspectOpeningPaths = (
    status: "queued" | "idle",
    mentions: DiscussionMentions,
    options: { readonly stepSession?: true } = {},
  ) =>
    runOnTestDatabase(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const sessions = yield* sessionRepository;
        const { sessionId } = yield* arrangeWaitingInputs(status, mentions, options);
        const session = Option.getOrThrow(yield* sessions.one(sessionId));
        return {
          findNextToOpenTurn: Option.isSome(yield* inputs.findNextToOpenTurn(sessionId)),
          listed: (yield* inputs.listSessionsAwaitingInput()).includes(sessionId),
          // Read before the claim below, which would take the row.
          inputWaiting: session.inputWaiting,
          claimed: Option.isSome(
            yield* inputs.claimOldestUnlessOneIsOnTheWire(sessionId, SECOND_SEND),
          ),
          atTurnEnd: Option.isSome(yield* inputs.findNextWaiting(sessionId)),
        };
      }),
    );

  it("is skipped on an idle session when it holds only mentions of new Posts", async () => {
    expect(await inspectOpeningPaths("idle", NEW_POSTS_MENTIONS)).toEqual({
      findNextToOpenTurn: false,
      listed: false,
      inputWaiting: false,
      claimed: false,
      atTurnEnd: true,
    });
  });

  it("opens a turn on an idle session when it holds an entry", async () => {
    expect(await inspectOpeningPaths("idle", ENTRY_MENTIONS)).toMatchObject({
      findNextToOpenTurn: true,
      listed: true,
      claimed: true,
    });
  });

  it("is skipped on an idle agent step's session, even with an entry", async () => {
    expect(await inspectOpeningPaths("idle", ENTRY_MENTIONS, { stepSession: true })).toEqual({
      findNextToOpenTurn: false,
      listed: false,
      inputWaiting: false,
      claimed: false,
      atTurnEnd: true,
    });
  });

  it("is never what a queued session starts with, even with an entry", async () => {
    expect(await inspectOpeningPaths("queued", ENTRY_MENTIONS)).toMatchObject({
      findNextToOpenTurn: false,
      listed: false,
      inputWaiting: false,
    });
  });
});

describe("the session's unsent Discussion Input", () => {
  it("loses its mentions and becomes the caller's input when it is rewritten", async () => {
    const row = await runOnTestDatabase(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const { sessionId, discussion } = yield* arrangeWaitingInputs("idle", ENTRY_MENTIONS);
        yield* inputs.rewrite(discussion.id, "my own words", "user");
        return {
          stored: Option.getOrThrow(yield* inputs.one(sessionId, discussion.id)),
          unsent: yield* inputs.readUnsentDiscussionInput(sessionId),
        };
      }),
    );
    expect(row.stored).toMatchObject({
      source: "user",
      actor: "user",
      text: "my own words",
      discussionMentions: null,
    });
    expect(Option.isNone(row.unsent)).toBe(true);
  });

  it("keeps its mentions and text as they were rewritten, until it is cancelled", async () => {
    const found = await runOnTestDatabase(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const { sessionId, discussion } = yield* arrangeWaitingInputs("idle", ENTRY_MENTIONS);
        yield* inputs.rewriteDiscussionMentions(discussion.id, NEW_POSTS_MENTIONS, "new text");
        const rewritten = Option.getOrThrow(yield* inputs.readUnsentDiscussionInput(sessionId));
        yield* inputs.cancelUnsentDiscussionInput(sessionId, "the session ended");
        return { rewritten, stored: yield* inputs.one(sessionId, discussion.id) };
      }),
    );
    expect(found.rewritten).toMatchObject({
      text: "new text",
      discussionMentions: NEW_POSTS_MENTIONS,
    });
    expect(Option.getOrThrow(found.stored)).toMatchObject({
      status: "cancelled",
      reason: "the session ended",
    });
  });
});
