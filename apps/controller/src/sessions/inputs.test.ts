/**
 * Tests the claim rules of the input repository:
 *
 * - `markDelivered`, `requeue` and `cancelWithReason` each change a row only
 *   while it still holds the claim of the send being answered;
 * - `claim` never claims an input of a session that has exited;
 * - a retired session claims only its flush;
 * - `takeOverWaitingInput` moves the input of exited sessions that are retired or
 *   cannot be resumed, oldest first, and leaves the rest where it is;
 * - `claimOldestUnlessOneIsOnTheWire` claims one input of an idle session at a time;
 * - an agent step's prompt marked `sent` is never sent again, and only a late
 *   confirmation changes it, to `delivered`.
 *
 * The case they guard against: an input is sent, the send is given up and
 * the row goes back to waiting, and the row is sent again. A late answer
 * about the first send carries the first claim's number, and must leave the
 * second send alone, even when both claims were made at the same time.
 */
import { describe, expect, it } from "vitest";
import { Effect, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { TestDatabase } from "../db/testing";
import {
  buildSendAttemptId,
  inputRepository,
  parseSendAttemptId,
  type StoredInput,
} from "./inputs";
import { sessionRepository } from "./repository";

const at = "2026-09-07T10:00:00.000Z";

/** When the first send claimed the row. */
const FIRST_SEND = "2026-09-07T10:01:00.000Z";

/** When the row was sent again, after the first send's claim was released. */
const SECOND_SEND = "2026-09-07T10:02:00.000Z";

/** The numbers (`sendAttempt`) of the first and the second claim of an input. */
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;

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
  yield* inputs.requeue(inputId, FIRST_ATTEMPT, "the runner did not answer in time");
  yield* inputs.claim(inputId, SECOND_SEND);
  return { sessionId, inputId };
});

/**
 * Arranges an input sent twice, applies `answer` to it, and returns the
 * stored input after the answer.
 */
const runInputAnswer = (
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

// These positive controls ensure the stale-answer regression cannot pass
// merely because the writes never change anything.
describe("an answer to the send that holds the row", () => {
  it("marks the input delivered", async () => {
    const row = await runInputAnswer((inputs, id) =>
      inputs.markDelivered(id, SECOND_ATTEMPT, "steered", at),
    );

    expect(row).toMatchObject({ status: "delivered", sentAt: null, delivery: "steered" });
  });

  it("puts the input back to waiting, with the reason", async () => {
    const row = await runInputAnswer((inputs, id) =>
      inputs.requeue(id, SECOND_ATTEMPT, "the harness refused it"),
    );

    expect(row).toMatchObject({
      status: "queued",
      sentAt: null,
      reason: "the harness refused it",
      delivery: null,
    });
  });

  it("cancels the input, with the reason", async () => {
    const row = await runInputAnswer((inputs, id) =>
      inputs.cancelWithReason(id, SECOND_ATTEMPT, "the session exited"),
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
        const marked = yield* inputs.markSent(prompt.id, FIRST_ATTEMPT);
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
      inputs.markDelivered(id, FIRST_ATTEMPT, "opened", at),
    );

    expect(row).toMatchObject({ status: "delivered", delivery: "opened", sentAt: null });
  });

  it("is never claimed, put back to waiting or cancelled", async () => {
    // A sent prompt is never sent again: the runner's answer about the step
    // settles the step.
    const { row } = await answerSentPrompt((inputs, id) =>
      Effect.gen(function* () {
        yield* inputs.requeue(id, FIRST_ATTEMPT, "the harness refused it");
        yield* inputs.cancelWithReason(id, FIRST_ATTEMPT, "the session exited");
        yield* inputs.claim(id, SECOND_SEND);
      }),
    );

    expect(row).toMatchObject({ status: "sent", sentAt: FIRST_SEND, reason: null });
  });
});

/**
 * Writes a session of the conversation `conversationId` with the given
 * status, retired or not. It has no native session id, so an exited one can
 * never be resumed.
 */
const insertConversationSession = (
  conversationId: string,
  state: { readonly status: "idle" | "exited"; readonly retired: boolean },
) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const sessionId = mintId();
    yield* sessions.insert({
      id: sessionId,
      title: "a session",
      permissionProfileId: mintId(),
      agentId: undefined,
      conversationId,
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
    yield* sessions.moved(sessionId, state.status, at);
    if (state.retired) yield* sessions.retire(sessionId, at);
    return sessionId;
  });

describe("a retired session's claims", () => {
  it("skip a user input older than the flush, and claim the flush", async () => {
    const { claimedUser, oldest } = await Effect.runPromise(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const sessionId = yield* insertConversationSession(mintId(), {
          status: "idle",
          retired: true,
        });
        const user = yield* inputs.insert({
          sessionId,
          source: "user",
          actor: "user",
          text: "hi",
          at,
        });
        yield* inputs.insert({
          sessionId,
          source: "rotation",
          actor: "system",
          text: "flush",
          at: SECOND_SEND,
        });
        return {
          claimedUser: yield* inputs.claim(user.id, FIRST_SEND),
          oldest: yield* inputs.claimOldestUnlessOneIsOnTheWire(sessionId, SECOND_SEND),
        };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(claimedUser).toEqual(Option.none());
    expect(Option.map(oldest, (one) => one.text)).toEqual(Option.some("flush"));
  });
});

describe("taking over the input of a conversation's earlier sessions", () => {
  /** Waits for a retired session that has exited, a retired one that is live, and a session of another conversation. */
  const arrangeSessions = Effect.gen(function* () {
    const inputs = yield* inputRepository;
    const conversationId = mintId();
    const exitedRetired = yield* insertConversationSession(conversationId, {
      status: "exited",
      retired: true,
    });
    const exitedNeverResumable = yield* insertConversationSession(conversationId, {
      status: "exited",
      retired: false,
    });
    const liveRetired = yield* insertConversationSession(conversationId, {
      status: "idle",
      retired: true,
    });
    const elsewhere = yield* insertConversationSession(mintId(), {
      status: "exited",
      retired: true,
    });
    const successor = yield* insertConversationSession(conversationId, {
      status: "idle",
      retired: false,
    });
    const write = (sessionId: string, source: "user" | "rotation", text: string, when: string) =>
      inputs.insert({ sessionId, source, actor: "user", text, at: when });
    return {
      inputs,
      conversationId,
      exitedRetired,
      exitedNeverResumable,
      liveRetired,
      elsewhere,
      successor,
      write,
    };
  });

  /** Reads the texts of the session's inputs that were not cancelled, oldest first. */
  const readTexts = (sessionId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ text: string }>`
        SELECT text FROM session_inputs
        WHERE session_id = ${uuidFromString(sessionId)} AND status <> 'cancelled'
        ORDER BY created_at, id`;
      return rows.map((row) => row.text);
    });

  it("moves what waits on exited sessions that are retired or cannot be resumed, and leaves the rest", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* arrangeSessions;
        yield* a.write(a.exitedRetired, "user", "second", SECOND_SEND);
        yield* a.write(a.exitedNeverResumable, "user", "first", FIRST_SEND);
        yield* a.write(a.exitedRetired, "rotation", "flush", FIRST_SEND);
        yield* a.write(a.liveRetired, "user", "stays on the live one", FIRST_SEND);
        yield* a.write(a.elsewhere, "user", "another conversation", FIRST_SEND);
        const had = yield* a.inputs.hasInputToTakeOver(a.conversationId);
        const moved = yield* a.inputs.takeOverWaitingInput(a.conversationId, a.successor);
        return {
          had,
          moved,
          hasMore: yield* a.inputs.hasInputToTakeOver(a.conversationId),
          successor: yield* readTexts(a.successor),
          exitedRetired: yield* readTexts(a.exitedRetired),
          liveRetired: yield* readTexts(a.liveRetired),
          elsewhere: yield* readTexts(a.elsewhere),
        };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(result).toEqual({
      had: true,
      moved: 2,
      hasMore: false,
      // Oldest first, whichever session each came from.
      successor: ["first", "second"],
      // A flush is never taken over.
      exitedRetired: ["flush"],
      liveRetired: ["stays on the live one"],
      elsewhere: ["another conversation"],
    });
  });

  it("sends a moved row again, even when it was on its way to the old session", async () => {
    const sentAt = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* arrangeSessions;
        const sql = yield* SqlClient.SqlClient;
        const row = yield* a.write(a.exitedRetired, "user", "on the wire", FIRST_SEND);
        yield* sql`UPDATE session_inputs SET sent_at = ${FIRST_SEND} WHERE id = ${uuidFromString(row.id)}`;
        yield* a.inputs.takeOverWaitingInput(a.conversationId, a.successor);
        return Option.map(yield* a.inputs.one(a.successor, row.id), (one) => one.sentAt);
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(sentAt).toEqual(Option.some(null));
  });
});

describe("the id of a send of an input", () => {
  it("is not built for an input that no send claimed", () => {
    expect(() => buildSendAttemptId({ id: mintId(), sentAt: null, sendAttempt: 0 })).toThrow(
      "not claimed",
    );
  });

  it.each([
    ["a bare input id", "0199e0e7-0000-7000-8000-0000000000fc"],
    ["an id that is no uuid", "not-a-uuid@1"],
    ["no number", "0199e0e7-0000-7000-8000-0000000000fc@"],
    ["a negative number", "0199e0e7-0000-7000-8000-0000000000fc@-1"],
    ["an empty string", ""],
  ])("is not parsed from %s", (_name, text) => {
    expect(parseSendAttemptId(text)).toBeUndefined();
  });
});

describe("two claims of an input at the same time", () => {
  it("get different send attempt ids, and a late answer to the first changes nothing", async () => {
    // A frozen or stepped-back clock gives the second claim the first one's time.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const { sessionId, inputId } = yield* insertSessionWithInput;
        const first = Option.getOrThrow(yield* inputs.claim(inputId, FIRST_SEND));
        yield* inputs.requeue(inputId, first.sendAttempt, "the runner did not answer in time");
        const second = Option.getOrThrow(yield* inputs.claim(inputId, FIRST_SEND));

        const lateDelivery = yield* inputs.markDelivered(inputId, first.sendAttempt, "opened", at);
        yield* inputs.requeue(inputId, first.sendAttempt, "a stale give-up");
        yield* inputs.cancelWithReason(inputId, first.sendAttempt, "a stale exit");
        const lateMark = yield* inputs.markSent(inputId, first.sendAttempt);
        const row = Option.getOrThrow(yield* inputs.one(sessionId, inputId));
        return { first, second, lateDelivery, lateMark, row };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(result.first.sentAt).toBe(result.second.sentAt);
    expect(buildSendAttemptId(result.first)).not.toBe(buildSendAttemptId(result.second));
    expect([result.first.sendAttempt, result.second.sendAttempt]).toEqual([1, 2]);
    expect([result.lateDelivery, result.lateMark]).toEqual([false, false]);
    expect(result.row).toMatchObject({
      status: "queued",
      sentAt: FIRST_SEND,
      sendAttempt: 2,
      reason: null,
      delivery: null,
    });
  });

  it("are numbered from the first claim, also for an input inserted claimed", async () => {
    const numbers = await Effect.runPromise(
      Effect.gen(function* () {
        const inputs = yield* inputRepository;
        const { sessionId } = yield* insertSessionWithInput;
        const claimedAtInsert = yield* inputs.insert({
          sessionId,
          source: "user",
          actor: "user",
          text: "claimed when it was written",
          at,
          sentAt: FIRST_SEND,
        });
        yield* inputs.requeue(claimedAtInsert.id, claimedAtInsert.sendAttempt, null);
        const again = Option.getOrThrow(yield* inputs.claim(claimedAtInsert.id, FIRST_SEND));
        return [claimedAtInsert.sendAttempt, again.sendAttempt];
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(numbers).toEqual([1, 2]);
  });
});
