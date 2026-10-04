/**
 * Tests the claim rules of the input repository:
 *
 * - `delivered`, `requeue` and `cancelWithReason` each change a row only
 *   while it still holds the claim of the send being answered;
 * - `claim` never claims an input of a session that has exited;
 * - `claimOldestUnlessOneIsOnTheWire` claims one input of an idle session at a time.
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
      inputs.delivered(id, FIRST_SEND, "steered", at),
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
      inputs.delivered(id, SECOND_SEND, "steered", at),
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
