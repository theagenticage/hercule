/**
 * Tests `ConversationService.send` on its own: the conversations domain stores
 * the owner's message and hands it to a `ConversationResponder` in the same
 * transaction. The responder here is a test double that records its calls, so
 * the tests see exactly what the messenger hands over, and when.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  createValidationError,
  type Conversation,
  type ConversationMessage,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { AfterCommit, uuidFromString, type Change } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { UsersLayer } from "../users";
import {
  ConversationMessagesLayer,
  ConversationResponder,
  ConversationService,
  ConversationServiceLayer,
} from "./index";

const USER_ID = "0199e0e7-0000-7000-8000-000000000000";

const USER: Actor = {
  _tag: "user",
  userId: USER_ID,
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const CONVERSATION_ID = "0199e0e7-0000-7000-8000-0000000000c1";
const ASSISTANT_ID = "0199e0e7-0000-7000-8000-0000000000a1";

const at = "2026-09-01T00:00:00.000Z";

/** One call the responder received, with what had been published when it arrived. */
interface ResponderCall {
  readonly conversation: Conversation;
  readonly message: ConversationMessage;
  readonly publishedBefore: ReadonlyArray<Change>;
}

/**
 * Builds a responder that records each call and then answers with `answer`,
 * and a listener that records every change a committed transaction publishes.
 * A call that arrives before the send's changes are published ran inside the
 * send's transaction.
 */
const buildRecorders = (answer: Effect.Effect<void, ReturnType<typeof createValidationError>>) => {
  const calls: Array<ResponderCall> = [];
  const published: Array<Change> = [];
  const responder = Layer.succeed(ConversationResponder, {
    messageSent: (conversation: Conversation, message: ConversationMessage) =>
      Effect.andThen(
        Effect.sync(() => {
          calls.push({ conversation, message, publishedBefore: [...published] });
        }),
        answer,
      ),
  });
  const listener = Layer.succeed(AfterCommit, {
    publish: (changes: ReadonlyArray<Change>) =>
      Effect.sync(() => {
        published.push(...changes);
      }),
  });
  return { calls, published, responder, listener };
};

/** Inserts the user, whose username labels the owner's messages, and one web conversation. */
const seed = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.andThen(
    sql`INSERT INTO users (id, username, password_hash, created_at, updated_at)
      VALUES (${uuidFromString(USER_ID)}, 'rogier', 'x', ${at}, ${at})`,
    sql`INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
      VALUES (${uuidFromString(CONVERSATION_ID)}, ${uuidFromString(ASSISTANT_ID)}, 'web', NULL, ${at})`,
  ),
);

/** Runs `body` as the user, against the service over a fresh database with the given recorders. */
const runWith = <A, E>(
  recorders: ReturnType<typeof buildRecorders>,
  body: Effect.Effect<A, E, ConversationService>,
): Promise<A> =>
  Effect.runPromise(
    Effect.andThen(seed, body).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(
        ConversationServiceLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              AuditLogLayer,
              UsersLayer,
              ConversationMessagesLayer,
              recorders.responder,
              recorders.listener,
            ),
          ),
          Layer.provideMerge(TestDatabase),
        ),
      ),
    ),
  );

/** Returns whether a change is a record change about the test's conversation. */
const isAboutConversation = (change: Change): boolean =>
  change._tag === "record" && change.id === CONVERSATION_ID;

describe("ConversationService.send", () => {
  it("stores the owner's message, hands it to the responder inside the transaction, and returns it", async () => {
    const recorders = buildRecorders(Effect.void);

    const { sent, conversation } = await runWith(
      recorders,
      Effect.gen(function* () {
        const conversations = yield* ConversationService;
        const sent = yield* conversations.send({ conversationId: CONVERSATION_ID, text: "hi" });
        const conversation = yield* conversations.read(CONVERSATION_ID);
        return { sent, conversation };
      }),
    );

    expect(sent).toMatchObject({
      conversationId: CONVERSATION_ID,
      position: 1,
      senderRole: "owner",
      senderLabel: "rogier",
      text: "hi",
      sessionId: null,
      turnId: null,
      actor: "user",
    });
    expect(recorders.calls).toHaveLength(1);
    expect(recorders.calls[0]!.conversation).toEqual(conversation);
    expect(recorders.calls[0]!.message).toEqual(sent);
    // The responder ran before anything about the conversation was published,
    // and the send published once it had committed.
    expect(recorders.calls[0]!.publishedBefore.filter(isAboutConversation)).toEqual([]);
    expect(recorders.published.filter(isAboutConversation)).not.toEqual([]);
  });

  it("fails with the responder's error and keeps no message when the responder refuses", async () => {
    const refusal = createValidationError([{ path: ["text"], message: "refused" }]);
    const refusing = buildRecorders(Effect.fail(refusal));

    const { error, remaining } = await runWith(
      refusing,
      Effect.gen(function* () {
        const conversations = yield* ConversationService;
        const error = yield* Effect.flip(
          conversations.send({ conversationId: CONVERSATION_ID, text: "hi" }),
        );
        const remaining = yield* conversations.queryMessages({ conversationId: CONVERSATION_ID });
        return { error, remaining };
      }),
    );

    expect(error).toEqual(refusal);
    expect(remaining.items).toEqual([]);
    expect(refusing.published.filter(isAboutConversation)).toEqual([]);
  });

  it("gives the next message position 1 after a refused send, because the refused one was rolled back", async () => {
    let refuse = true;
    const recorders = buildRecorders(
      Effect.suspend(() =>
        refuse
          ? Effect.fail(createValidationError([{ path: ["text"], message: "refused" }]))
          : Effect.void,
      ),
    );

    const next = await runWith(
      recorders,
      Effect.gen(function* () {
        const conversations = yield* ConversationService;
        yield* Effect.flip(conversations.send({ conversationId: CONVERSATION_ID, text: "hi" }));
        refuse = false;
        return yield* conversations.send({ conversationId: CONVERSATION_ID, text: "again" });
      }),
    );

    expect(next).toMatchObject({ position: 1, text: "again" });
  });
});
