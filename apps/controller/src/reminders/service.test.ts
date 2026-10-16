/**
 * Tests the reminder operations against a migrated database, as each kind of
 * caller. The rules under test:
 *
 * - a session token reaches only its own conversation's reminders, and a
 *   foreign conversation or reminder fails like a missing one;
 * - a user credential names the conversation to create in, and may list all;
 * - a reminder's time must be in the future, and only a pending reminder
 *   can be cancelled;
 * - every write announces on the `conversation` topic;
 * - the Scheduler's read, `listDue`, returns due reminders oldest first,
 *   a page at a time. The Scheduler's own tests prove that a reminder
 *   fires once and never once cancelled.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Grant } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { buildAnnouncementRecorder, TestDatabase } from "../db/testing";
import { reminderRepository, ReminderService, ReminderServiceLayer } from "./index";

type Deps = ReminderService | SqlClient.SqlClient;

const layer = ReminderServiceLayer.pipe(Layer.provideMerge(TestDatabase));

const CONVERSATION = "0199e0e7-0000-7000-8000-0000000000c1";
const OTHER_CONVERSATION = "0199e0e7-0000-7000-8000-0000000000c2";
const UNKNOWN_CONVERSATION = "0199e0e7-0000-7000-8000-0000000000ff";
const SESSION = "0199e0e7-0000-7000-8000-00000000005e";
const OTHER_SESSION = "0199e0e7-0000-7000-8000-00000000005f";
const LONE_SESSION = "0199e0e7-0000-7000-8000-000000000060";
const UNKNOWN_REMINDER = "0199e0e7-0000-7000-8000-0000000000fe";
const AT = "2026-10-11T00:00:00.000Z";
const SOON = "2099-01-01T00:00:00.000Z";
const LATER = "2099-02-01T00:00:00.000Z";
const PAST = "2020-01-01T00:00:00.000Z";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const GRANTS: ReadonlyArray<Grant> = ["subscription.read", "subscription.write"];

const buildSession = (sessionId: string): Actor => ({
  _tag: "session",
  sessionId,
  profileId: "0199e0e7-0000-7000-8000-0000000000f0",
  grants: GRANTS,
  profileGrants: GRANTS,
  assistantId: null,
  agentId: null,
});

const hex = (id: string): string => id.replaceAll("-", "");

/**
 * Inserts two conversations, a session in each, and a session in none. Only
 * the columns the reminders domain reads are meaningful.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const conversation of [CONVERSATION, OTHER_CONVERSATION]) {
    // The web channel allows one conversation per assistant, so each gets its own.
    yield* sql`INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
      VALUES (unhex(${hex(conversation)}), unhex(${hex(conversation)}), 'web', NULL, ${AT})`;
  }
  const sessions: ReadonlyArray<readonly [string, string | null]> = [
    [SESSION, CONVERSATION],
    [OTHER_SESSION, OTHER_CONVERSATION],
    [LONE_SESSION, null],
  ];
  for (const [id, conversation] of sessions) {
    yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                     requested_access_mode, access_mode, spec, title, status,
                                     created_at, last_activity_at, conversation_id)
      VALUES (unhex(${hex(id)}), zeroblob(16), zeroblob(16), zeroblob(16), 'auto', 'auto', '{}', 'a session', 'exited',
              ${AT}, ${AT}, ${conversation === null ? null : Buffer.from(hex(conversation), "hex")})`;
  }
});

/** Runs an effect as `actor` on a seeded database, and returns its announcements too. */
const runAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) => {
  const { listener, announced } = buildAnnouncementRecorder();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* seed;
      return yield* Effect.provideService(effect, CurrentActor, actor);
    }).pipe(Effect.provide(layer), Effect.provide(listener)),
  ).then((value) => ({ value, announced }));
};

const run = async <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>): Promise<A> =>
  (await runAs(actor, effect)).value;

/** Runs a call that is expected to fail, and returns its error. */
const runError = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) =>
  run(actor, Effect.flip(effect));

const issueMessage = (error: unknown): string =>
  JSON.stringify((error as { readonly error: unknown }).error);

describe("reminder.create", () => {
  it("refuses a reminder past the cap of pending ones, until some are cancelled", async () => {
    const { error, afterCancel } = await run(
      USER,
      Effect.gen(function* () {
        const reminders = yield* ReminderService;
        const input = { conversationId: CONVERSATION, at: SOON, text: "x" };
        let firstId = "";
        for (let count = 0; count < 100; count += 1) {
          const { reminderId } = yield* reminders.create(input);
          if (count === 0) firstId = reminderId;
        }
        const error = yield* Effect.flip(reminders.create(input));
        yield* reminders.cancel(firstId);
        return { error, afterCancel: yield* reminders.create(input) };
      }),
    );
    expect(issueMessage(error)).toContain("cancel some");
    expect(afterCancel.reminderId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stores a pending reminder in the named conversation, stamped with the user", async () => {
    const { value, announced } = await runAs(
      USER,
      Effect.gen(function* () {
        const reminders = yield* ReminderService;
        const { reminderId } = yield* reminders.create({
          conversationId: CONVERSATION,
          at: SOON,
          text: "chase the invoice",
        });
        return (yield* reminders.query({})).items.find((item) => item.id === reminderId);
      }),
    );
    expect(value).toMatchObject({
      conversationId: CONVERSATION,
      at: SOON,
      text: "chase the invoice",
      status: "pending",
      actor: "user",
      firedAt: null,
    });
    expect(announced).toEqual([
      { _tag: "record", topic: "conversation", id: CONVERSATION, kind: "updated" },
    ]);
  });

  it("puts a session's reminder in its own conversation, stamped with the session", async () => {
    const reminder = await run(
      buildSession(SESSION),
      Effect.gen(function* () {
        const reminders = yield* ReminderService;
        yield* reminders.create({ at: SOON, text: "later" });
        return (yield* reminders.query({})).items[0];
      }),
    );
    expect(reminder).toMatchObject({
      conversationId: CONVERSATION,
      actor: `session:${SESSION}`,
    });
  });

  it("lets a session name its own conversation", async () => {
    const created = await run(
      buildSession(SESSION),
      Effect.flatMap(ReminderService, (reminders) =>
        reminders.create({ conversationId: CONVERSATION, at: SOON, text: "later" }),
      ),
    );
    expect(created.reminderId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a session that is in no conversation, saying only an assistant's session can set one", async () => {
    const error = await runError(
      buildSession(LONE_SESSION),
      Effect.flatMap(ReminderService, (reminders) => reminders.create({ at: SOON, text: "x" })),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
    expect(issueMessage(error)).toContain("only an assistant's session can set a reminder");
  });

  it("refuses a session that names another conversation, as if it did not exist", async () => {
    const error = await runError(
      buildSession(SESSION),
      Effect.flatMap(ReminderService, (reminders) =>
        reminders.create({ conversationId: OTHER_CONVERSATION, at: SOON, text: "x" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found", message: "no such conversation" } });
  });

  it("refuses a user credential that names no conversation", async () => {
    const error = await runError(
      USER,
      Effect.flatMap(ReminderService, (reminders) => reminders.create({ at: SOON, text: "x" })),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
    expect(issueMessage(error)).toContain("conversationId");
  });

  it("refuses an unknown conversation", async () => {
    const error = await runError(
      USER,
      Effect.flatMap(ReminderService, (reminders) =>
        reminders.create({ conversationId: UNKNOWN_CONVERSATION, at: SOON, text: "x" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("refuses a time that has passed, and stores nothing", async () => {
    const { error, items } = await run(
      USER,
      Effect.gen(function* () {
        const reminders = yield* ReminderService;
        const failure = yield* Effect.flip(
          reminders.create({ conversationId: CONVERSATION, at: PAST, text: "x" }),
        );
        return { error: failure, items: (yield* reminders.query({})).items };
      }),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
    expect(issueMessage(error)).toContain("give a time in the future");
    expect(items).toEqual([]);
  });
});

describe("reminder.query", () => {
  /** Sets three reminders: two in CONVERSATION (LATER first, then SOON), one in the other. */
  const setThree = Effect.gen(function* () {
    const reminders = yield* ReminderService;
    yield* reminders.create({ conversationId: CONVERSATION, at: LATER, text: "later" });
    yield* reminders.create({ conversationId: CONVERSATION, at: SOON, text: "soon" });
    yield* reminders.create({ conversationId: OTHER_CONVERSATION, at: SOON, text: "other" });
    return reminders;
  });

  it("lets a user credential list every conversation's reminders, soonest first", async () => {
    const items = await run(
      USER,
      Effect.flatMap(setThree, (reminders) => reminders.query({})),
    ).then((page) => page.items);
    expect(items.map((item) => item.at)).toEqual([SOON, SOON, LATER]);
  });

  it("narrows to a conversation and to a status", async () => {
    const { inConversation, cancelled } = await run(
      USER,
      Effect.gen(function* () {
        const reminders = yield* setThree;
        const all = (yield* reminders.query({ conversationId: CONVERSATION })).items;
        yield* reminders.cancel(all[0]!.id);
        return {
          inConversation: all.map((item) => item.text),
          cancelled: (yield* reminders.query({ status: "cancelled" })).items.map(
            (item) => item.text,
          ),
        };
      }),
    );
    expect(inConversation).toEqual(["soon", "later"]);
    expect(cancelled).toEqual(["soon"]);
  });

  it("pages with a cursor", async () => {
    const texts = await run(
      USER,
      Effect.gen(function* () {
        const reminders = yield* setThree;
        const first = yield* reminders.query({ limit: 2 });
        const second = yield* reminders.query({ limit: 2, cursor: first.nextCursor! });
        return [first.items.length, second.items.map((item) => item.at), second.nextCursor];
      }),
    );
    expect(texts).toEqual([2, [LATER], undefined]);
  });

  it("gives a user credential NotFound for an unknown conversation", async () => {
    const error = await runError(
      USER,
      Effect.flatMap(ReminderService, (reminders) =>
        reminders.query({ conversationId: UNKNOWN_CONVERSATION }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("gives a session only its own conversation's reminders", async () => {
    const own = await run(
      USER,
      Effect.gen(function* () {
        const reminders = yield* setThree;
        const page = yield* Effect.provideService(
          reminders.query({}),
          CurrentActor,
          buildSession(SESSION),
        );
        return page.items.map((item) => item.text);
      }),
    );
    expect(own).toEqual(["soon", "later"]);
  });

  it("refuses a session that names another conversation, as if it did not exist", async () => {
    const error = await runError(
      buildSession(SESSION),
      Effect.flatMap(ReminderService, (reminders) =>
        reminders.query({ conversationId: OTHER_CONVERSATION }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found", message: "no such conversation" } });
  });

  it("refuses a session that is in no conversation", async () => {
    const error = await runError(
      buildSession(LONE_SESSION),
      Effect.flatMap(ReminderService, (reminders) => reminders.query({})),
    );
    expect(error).toMatchObject({ error: { code: "validation" } });
  });
});

describe("reminder.cancel", () => {
  /** Creates a reminder in CONVERSATION as the user and returns its id. */
  const createOne = Effect.flatMap(ReminderService, (reminders) =>
    Effect.map(
      reminders.create({ conversationId: CONVERSATION, at: SOON, text: "x" }),
      (created) => created.reminderId,
    ),
  );

  it.each([
    { caller: "the user", actor: USER, stamp: "user" },
    {
      caller: "its conversation's session",
      actor: buildSession(SESSION),
      stamp: `session:${SESSION}`,
    },
  ])(
    "cancels a pending reminder as $caller, records who and when, and announces the conversation",
    async ({ actor, stamp }) => {
      const { value, announced } = await runAs(
        USER,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const reminders = yield* ReminderService;
          const id = yield* createOne;
          yield* Effect.provideService(reminders.cancel(id), CurrentActor, actor);
          return {
            status: (yield* reminders.query({})).items[0]?.status,
            row: (yield* sql<{
              readonly cancelled_at: string | null;
              readonly cancelled_by: string;
            }>`
            SELECT cancelled_at, cancelled_by FROM reminders`)[0],
          };
        }),
      );
      expect(value.status).toBe("cancelled");
      expect(value.row?.cancelled_by).toBe(stamp);
      expect(value.row?.cancelled_at).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(announced).toEqual([
        { _tag: "record", topic: "conversation", id: CONVERSATION, kind: "updated" },
        { _tag: "record", topic: "conversation", id: CONVERSATION, kind: "updated" },
      ]);
    },
  );

  it("refuses a session cancelling another conversation's reminder, as if it did not exist", async () => {
    const { error, status } = await run(
      USER,
      Effect.gen(function* () {
        const id = yield* createOne;
        const reminders = yield* ReminderService;
        const failure = yield* Effect.flip(
          Effect.provideService(reminders.cancel(id), CurrentActor, buildSession(OTHER_SESSION)),
        );
        return { error: failure, status: (yield* reminders.query({})).items[0]?.status };
      }),
    );
    expect(error).toMatchObject({ error: { code: "not_found", message: "no such reminder" } });
    expect(status).toBe("pending");
  });

  it("refuses a session in no conversation the same way", async () => {
    const error = await run(
      USER,
      Effect.gen(function* () {
        const id = yield* createOne;
        const reminders = yield* ReminderService;
        return yield* Effect.flip(
          Effect.provideService(reminders.cancel(id), CurrentActor, buildSession(LONE_SESSION)),
        );
      }),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("fails with NotFound for an unknown reminder", async () => {
    const error = await runError(
      USER,
      Effect.flatMap(ReminderService, (reminders) => reminders.cancel(UNKNOWN_REMINDER)),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("fails with InvalidState for a reminder that is cancelled or fired", async () => {
    const { twice, afterFiring } = await run(
      USER,
      Effect.gen(function* () {
        const reminders = yield* ReminderService;
        const repository = yield* reminderRepository;
        const first = yield* createOne;
        yield* reminders.cancel(first);
        const twice = yield* Effect.flip(reminders.cancel(first));
        const second = yield* createOne;
        yield* repository.markFired(second, AT);
        return { twice, afterFiring: yield* Effect.flip(reminders.cancel(second)) };
      }),
    );
    expect(twice).toMatchObject({ error: { code: "invalid_state" } });
    expect(afterFiring).toMatchObject({ error: { code: "invalid_state" } });
  });
});

describe("the Scheduler's reads", () => {
  it("lists due reminders by their time, not the order they were created in", async () => {
    const result = await run(
      USER,
      Effect.gen(function* () {
        const reminders = yield* ReminderService;
        const repository = yield* reminderRepository;
        const late = yield* reminders.create({
          conversationId: CONVERSATION,
          at: LATER,
          text: "late",
        });
        const early = yield* reminders.create({
          conversationId: CONVERSATION,
          at: SOON,
          text: "early",
        });
        const due = yield* repository.listDue("2100-01-01T00:00:00.000Z");
        return { due: due.map((item) => item.id), early: early.reminderId, late: late.reminderId };
      }),
    );
    expect(result.due).toEqual([result.early, result.late]);
  });

  it("returns at most 100 due reminders at a time, the rest on the next read", async () => {
    const { first, second } = await run(
      USER,
      Effect.gen(function* () {
        const repository = yield* reminderRepository;
        const sql = yield* SqlClient.SqlClient;
        for (let index = 0; index < 103; index += 1) {
          yield* repository.insert({
            conversationId: CONVERSATION,
            at: AT,
            text: "x",
            createdAt: AT,
            actor: "user",
          });
        }
        const first = yield* repository.listDue(SOON);
        yield* sql`UPDATE reminders SET status = 'fired', fired_at = ${AT}
                   WHERE id IN ${sql.in(first.map((item) => Buffer.from(hex(item.id), "hex")))}`;
        return { first, second: yield* repository.listDue(SOON) };
      }),
    );
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(3);
  });
});
