import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import {
  MEMORY_CORE_CAP,
  MEMORY_TOPIC_CAP,
  MEMORY_TOPIC_COUNT_CAP,
  type Grant,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { MemoryService, MemoryServiceLayer, memoryRepository } from "./index";

type Deps = MemoryService | SqlClient.SqlClient;

const layer = MemoryServiceLayer.pipe(
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

const ASSISTANT = "0199e0e7-0000-7000-8000-0000000000a1";
const OTHER_ASSISTANT = "0199e0e7-0000-7000-8000-0000000000a2";
const UNKNOWN_ASSISTANT = "0199e0e7-0000-7000-8000-0000000000ff";
const AT = "2026-10-11T00:00:00.000Z";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const MEMORY_GRANTS: ReadonlyArray<Grant> = ["memory.read", "memory.write"];

/** A session of `assistantId`'s conversation, or a session outside any conversation for null. */
const buildSession = (assistantId: string | null): Actor => ({
  _tag: "session",
  sessionId: "0199e0e7-0000-7000-8000-00000000005e",
  profileId: "0199e0e7-0000-7000-8000-0000000000f0",
  grants: MEMORY_GRANTS,
  profileGrants: MEMORY_GRANTS,
  assistantId,
  agentId: assistantId,
});

const RUN: Actor = { _tag: "run", runId: "r1", stepId: "s1", workflowId: null };

/**
 * Inserts an assistant with an empty `core`, as `assistant.create` leaves
 * one. Only the rows memory reads are written.
 */
const insertAssistant = (id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const memory = yield* memoryRepository;
    const hex = id.replaceAll("-", "");
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        yield* sql`INSERT INTO agents (id, kind, name, system_prompt, instance_id, permission_profile_id,
                                       access_mode, model_selection, disallowed_tools,
                                       created_at, updated_at)
          VALUES (unhex(${hex}), 'assistant', 'Hercule', '', unhex(${hex}), unhex(${hex}),
                  'full-access', NULL, '[]', ${AT}, ${AT})`;
        yield* sql`INSERT INTO assistants (agent_id, heartbeat, rotation, reply, created_at)
          VALUES (unhex(${hex}), '{}', '{}', 'turn-end', ${AT})`;
        yield* memory.insert({
          assistantId: id,
          name: "core",
          gist: "",
          body: "",
          size: 0,
          at: AT,
          actor: "user",
        });
      }),
    );
  });

/** Runs an effect as `actor` against a database with two assistants. */
const runAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* insertAssistant(ASSISTANT);
      yield* insertAssistant(OTHER_ASSISTANT);
      return yield* Effect.provideService(effect, CurrentActor, actor);
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
  );

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) => runAs(USER, effect);

/** Runs a call that is expected to fail as `actor`, and returns its error. */
const runErrorAs = <A, E>(actor: Actor, effect: Effect.Effect<A, E, Deps>) =>
  runAs(actor, Effect.flip(effect));

const runError = <A, E>(effect: Effect.Effect<A, E, Deps>) => runErrorAs(USER, effect);

const memory = MemoryService;

/** Returns the message of an API error, the text the caller reads. */
const readMessage = (error: unknown): string =>
  (error as { readonly error: { readonly message: string } }).error.message;

describe("memory.write", () => {
  it("creates a topic, then replaces its body and keeps its gist when none is given", async () => {
    const document = await run(
      Effect.gen(function* () {
        const service = yield* memory;
        yield* service.write({ id: ASSISTANT, name: "people", body: "Ada", gist: "who is who" });
        return yield* service.write({ id: ASSISTANT, name: "people", body: "Ada and Grace" });
      }),
    );
    expect(document).toMatchObject({ name: "people", body: "Ada and Grace", gist: "who is who" });
    expect(document.size).toBe(13);
  });

  it("refuses a gist given for core", async () => {
    const error = await runError(
      Effect.flatMap(memory, (service) =>
        service.write({ id: ASSISTANT, name: "core", body: "x", gist: "refused" }),
      ),
    );
    expect(error).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["gist"] }] } },
    });
    expect(JSON.stringify(error)).toContain("core has no gist");
  });

  describe("versions", () => {
    it("stores every write and append at a higher version, and reads the last one", async () => {
      const versions = await run(
        Effect.gen(function* () {
          const service = yield* memory;
          const created = yield* service.write({ id: ASSISTANT, name: "notes", body: "a" });
          const rewritten = yield* service.write({ id: ASSISTANT, name: "notes", body: "b" });
          const appended = yield* service.append({ id: ASSISTANT, name: "notes", body: "c" });
          const read = yield* service.read({ id: ASSISTANT, name: "notes" });
          return [created.version, rewritten.version, appended.version, read.version];
        }),
      );
      const [created, rewritten, appended, read] = versions;
      expect(created).toBeGreaterThan(0);
      expect(rewritten).toBeGreaterThan(created!);
      expect(appended).toBeGreaterThan(rewritten!);
      expect(read).toBe(appended);
    });

    it("writes when the document is still at the expected version", async () => {
      const document = await run(
        Effect.gen(function* () {
          const service = yield* memory;
          const created = yield* service.write({ id: ASSISTANT, name: "notes", body: "a" });
          return yield* service.write({
            id: ASSISTANT,
            name: "notes",
            body: "b",
            expectedVersion: created.version,
          });
        }),
      );
      expect(document).toMatchObject({ body: "b" });
    });

    it("refuses a write from a stale copy and keeps the newer text", async () => {
      const result = await run(
        Effect.gen(function* () {
          const service = yield* memory;
          const read = yield* service.write({ id: ASSISTANT, name: "decisions", body: "a" });
          const appended = yield* service.append({ id: ASSISTANT, name: "decisions", body: "b" });
          const refused = yield* Effect.flip(
            service.write({
              id: ASSISTANT,
              name: "decisions",
              body: "x",
              expectedVersion: read.version,
            }),
          );
          return {
            read,
            appended,
            refused,
            stored: yield* service.read({ id: ASSISTANT, name: "decisions" }),
          };
        }),
      );
      expect(result.refused).toMatchObject({ error: { code: "conflict" } });
      expect(readMessage(result.refused)).toBe(
        `topic "decisions" changed since you read it (version ${String(result.appended.version)}, you expected ${String(result.read.version)}); read it again and redo your edit`,
      );
      expect(result.stored).toMatchObject({ body: "a\nb", version: result.appended.version });
    });

    it("refuses a stale write before the shrink guard", async () => {
      const error = await runError(
        Effect.gen(function* () {
          const service = yield* memory;
          yield* service.write({ id: ASSISTANT, name: "notes", body: "a".repeat(2_000) });
          return yield* service.write({
            id: ASSISTANT,
            name: "notes",
            body: "",
            expectedVersion: 5,
          });
        }),
      );
      expect(error).toMatchObject({ error: { code: "conflict" } });
    });

    it("creates a topic when expectedVersion is 0 and it does not exist", async () => {
      const document = await run(
        Effect.flatMap(memory, (service) =>
          service.write({ id: ASSISTANT, name: "fresh", body: "a", expectedVersion: 0 }),
        ),
      );
      expect(document).toMatchObject({ name: "fresh", body: "a" });
    });

    it("refuses expectedVersion 0 for a topic that exists", async () => {
      const error = await runError(
        Effect.gen(function* () {
          const service = yield* memory;
          yield* service.write({ id: ASSISTANT, name: "x", body: "a" });
          return yield* service.write({ id: ASSISTANT, name: "x", body: "b", expectedVersion: 0 });
        }),
      );
      expect(error).toMatchObject({ error: { code: "conflict" } });
      expect(readMessage(error)).toBe(
        'a topic named "x" already exists; read it, or write without expectedVersion to replace it',
      );
    });

    it("refuses a write from a copy of a topic that was deleted and created again", async () => {
      const result = await run(
        Effect.gen(function* () {
          const service = yield* memory;
          const read = yield* service.write({ id: ASSISTANT, name: "again", body: "old" });
          yield* service.delete({ id: ASSISTANT, name: "again" });
          yield* service.write({ id: ASSISTANT, name: "again", body: "new" });
          const refused = yield* Effect.flip(
            service.write({
              id: ASSISTANT,
              name: "again",
              body: "from the deleted copy",
              expectedVersion: read.version,
            }),
          );
          return { refused, stored: yield* service.read({ id: ASSISTANT, name: "again" }) };
        }),
      );
      expect(result.refused).toMatchObject({ error: { code: "conflict" } });
      expect(result.stored.body).toBe("new");
    });

    it("refuses a write expecting a version of a topic that was deleted", async () => {
      const error = await runError(
        Effect.gen(function* () {
          const service = yield* memory;
          yield* service.write({ id: ASSISTANT, name: "gone", body: "a" });
          yield* service.delete({ id: ASSISTANT, name: "gone" });
          return yield* service.write({
            id: ASSISTANT,
            name: "gone",
            body: "b",
            expectedVersion: 1,
          });
        }),
      );
      expect(error).toMatchObject({ error: { code: "conflict" } });
      expect(readMessage(error)).toContain("Write without expectedVersion to create it again");
    });
  });

  it("accepts core at its cap and refuses one character more, naming the size and the cap", async () => {
    const atCap = await run(
      Effect.flatMap(memory, (service) =>
        service.write({ id: ASSISTANT, name: "core", body: "a".repeat(MEMORY_CORE_CAP) }),
      ),
    );
    expect(atCap.size).toBe(MEMORY_CORE_CAP);

    const error = await runError(
      Effect.flatMap(memory, (service) =>
        service.write({ id: ASSISTANT, name: "core", body: "a".repeat(MEMORY_CORE_CAP + 1) }),
      ),
    );
    expect(error).toMatchObject({
      error: {
        code: "cap_exceeded",
        details: { size: MEMORY_CORE_CAP + 1, cap: MEMORY_CORE_CAP },
      },
    });
    expect(readMessage(error)).toMatch(/^core is 4,001 chars; cap is 4,000/);
  });

  it("counts an emoji as one character", async () => {
    const document = await run(
      Effect.flatMap(memory, (service) =>
        service.write({ id: ASSISTANT, name: "core", body: "🙂".repeat(MEMORY_CORE_CAP) }),
      ),
    );
    expect(document.size).toBe(MEMORY_CORE_CAP);
  });

  it("names a topic in the cap message", async () => {
    const error = await runError(
      Effect.flatMap(memory, (service) =>
        service.write({ id: ASSISTANT, name: "decisions", body: "a".repeat(12_009) }),
      ),
    );
    expect(readMessage(error)).toMatch(/^topic "decisions" is 12,009 chars; cap is 12,000/);
    expect(error).toMatchObject({ error: { details: { size: 12_009, cap: MEMORY_TOPIC_CAP } } });
  });

  it("refuses a 25th topic, naming the count and the cap, and still rewrites an existing one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* memory;
        for (let index = 0; index < MEMORY_TOPIC_COUNT_CAP; index += 1) {
          yield* service.write({ id: ASSISTANT, name: `topic ${String(index)}`, body: "x" });
        }
        const refused = yield* Effect.flip(
          service.write({ id: ASSISTANT, name: "one too many", body: "x" }),
        );
        const rewritten = yield* service.write({ id: ASSISTANT, name: "topic 0", body: "y" });
        return { refused, rewritten };
      }),
    );
    expect(result.refused).toMatchObject({
      error: { code: "cap_exceeded", details: { count: 25, cap: MEMORY_TOPIC_COUNT_CAP } },
    });
    expect(result.rewritten.body).toBe("y");
  });

  describe("the shrink guard", () => {
    /** Writes `before` characters, then `after`, and returns the second write's result. */
    const shrink = (before: number, after: number, confirmShrink?: boolean) =>
      Effect.gen(function* () {
        const service = yield* memory;
        yield* service.write({ id: ASSISTANT, name: "notes", body: "a".repeat(before) });
        return yield* service.write({
          id: ASSISTANT,
          name: "notes",
          body: "a".repeat(after),
          ...(confirmShrink === undefined ? {} : { confirmShrink }),
        });
      });

    it("refuses losing more than half of 1,000 characters, naming both sizes and how to confirm", async () => {
      const error = await runError(shrink(1_000, 499));
      expect(error).toMatchObject({
        error: { code: "shrink_rejected", details: { previousSize: 1_000, size: 499 } },
      });
      expect(readMessage(error)).toContain("from 1,000 to 499 chars");
      expect(readMessage(error)).toContain("discarding 501 chars");
      expect(readMessage(error)).toContain("confirmShrink: true");
      expect(readMessage(error)).toContain("--confirm-shrink true");
    });

    it("allows losing exactly half", async () => {
      expect((await run(shrink(1_000, 500))).size).toBe(500);
    });

    it("does not guard a document under 1,000 characters", async () => {
      expect((await run(shrink(999, 0))).size).toBe(0);
    });

    it("allows the shrink when it is confirmed", async () => {
      expect((await run(shrink(2_000, 10, true))).size).toBe(10);
    });
  });

  it("records the assistant, the name and the size in the audit log, never the body", async () => {
    const entries = await run(
      Effect.gen(function* () {
        yield* (yield* memory).write({ id: ASSISTANT, name: "secret", body: "the body text" });
        return yield* readEventsOfKind("memory.written");
      }),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.payload).toEqual({ assistantId: ASSISTANT, name: "secret", size: 13 });
    expect(JSON.stringify(entries[0])).not.toContain("the body text");
  });
});

describe("memory.append", () => {
  it("starts the text on a new line unless the body is empty or ends with one", async () => {
    const bodies = await run(
      Effect.gen(function* () {
        const service = yield* memory;
        const fromEmpty = yield* service.append({ id: ASSISTANT, name: "core", body: "one" });
        const joined = yield* service.append({ id: ASSISTANT, name: "core", body: "two\n" });
        const afterNewline = yield* service.append({ id: ASSISTANT, name: "core", body: "three" });
        return [fromEmpty.body, joined.body, afterNewline.body];
      }),
    );
    expect(bodies).toEqual(["one", "one\ntwo\n", "one\ntwo\nthree"]);
  });

  it("keeps the gist and audits the new size", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* memory;
        yield* service.write({ id: ASSISTANT, name: "people", body: "Ada", gist: "who" });
        const document = yield* service.append({ id: ASSISTANT, name: "people", body: "Grace" });
        return { document, entries: yield* readEventsOfKind("memory.appended") };
      }),
    );
    expect(result.document).toMatchObject({ gist: "who", body: "Ada\nGrace", size: 9 });
    expect(result.entries[0]!.payload).toEqual({ assistantId: ASSISTANT, name: "people", size: 9 });
  });

  it("refuses empty text, which adds nothing", async () => {
    const error = await runError(
      Effect.flatMap(memory, (service) =>
        service.append({ id: ASSISTANT, name: "core", body: "" }),
      ),
    );
    expect(error).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["body"] }] } },
    });
  });

  it("refuses a topic that does not exist, pointing to write", async () => {
    const error = await runError(
      Effect.flatMap(memory, (service) =>
        service.append({ id: ASSISTANT, name: "missing", body: "x" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
    expect(readMessage(error)).toContain("hercule memory write");
  });

  it("refuses a result over the cap", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const service = yield* memory;
        yield* service.write({ id: ASSISTANT, name: "core", body: "a".repeat(MEMORY_CORE_CAP) });
        return yield* service.append({ id: ASSISTANT, name: "core", body: "b" });
      }),
    );
    // The joining newline counts too.
    expect(error).toMatchObject({
      error: { code: "cap_exceeded", details: { size: MEMORY_CORE_CAP + 2 } },
    });
  });
});

describe("memory.delete", () => {
  it("refuses core, saying how to clear it", async () => {
    const error = await runError(
      Effect.flatMap(memory, (service) => service.delete({ id: ASSISTANT, name: "core" })),
    );
    expect(error).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["name"] }] } },
    });
    expect(JSON.stringify(error)).toContain("empty body");
  });

  it("deletes a topic and audits its size", async () => {
    const result = await run(
      Effect.gen(function* () {
        const service = yield* memory;
        yield* service.write({ id: ASSISTANT, name: "old", body: "abc" });
        yield* service.delete({ id: ASSISTANT, name: "old" });
        return {
          index: yield* service.list({ id: ASSISTANT }),
          entries: yield* readEventsOfKind("memory.deleted"),
        };
      }),
    );
    expect(result.index.map((entry) => entry.name)).toEqual(["core"]);
    expect(result.entries[0]!.payload).toEqual({ assistantId: ASSISTANT, name: "old", size: 3 });
  });

  it("refuses a topic that does not exist", async () => {
    const error = await runError(
      Effect.flatMap(memory, (service) => service.delete({ id: ASSISTANT, name: "missing" })),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("memory.list", () => {
  it("returns core first, then the topics by name", async () => {
    const index = await run(
      Effect.gen(function* () {
        const service = yield* memory;
        yield* service.write({ id: ASSISTANT, name: "zebra", body: "z" });
        yield* service.write({ id: ASSISTANT, name: "alpha", body: "a", gist: "first" });
        return yield* service.list({ id: ASSISTANT });
      }),
    );
    expect(index).toEqual([
      { name: "core", gist: "", size: 0 },
      { name: "alpha", gist: "first", size: 1 },
      { name: "zebra", gist: "", size: 1 },
    ]);
  });

  it("refuses an assistant that does not exist", async () => {
    const error = await runError(
      Effect.flatMap(memory, (service) => service.list({ id: UNKNOWN_ASSISTANT })),
    );
    expect(error).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("memory.search", () => {
  it("returns the matching documents with a window of text around each hit", async () => {
    const matches = await run(
      Effect.gen(function* () {
        const service = yield* memory;
        yield* service.write({
          id: ASSISTANT,
          name: "core",
          body: "Rogier prefers short answers. He lives in Amsterdam.",
        });
        yield* service.write({ id: ASSISTANT, name: "travel", body: "Flights to Amsterdam." });
        yield* service.write({ id: ASSISTANT, name: "food", body: "No cilantro." });
        // Another assistant's memory is never searched.
        yield* service.write({ id: OTHER_ASSISTANT, name: "core", body: "Amsterdam too." });
        return yield* service.search({ id: ASSISTANT, text: "amsterdam" });
      }),
    );
    expect(matches.map((match) => match.name).sort()).toEqual(["core", "travel"]);
    const travel = matches.find((match) => match.name === "travel");
    expect(travel?.snippets).toEqual(["Flights to Amsterdam."]);
  });

  it("matches nothing for text with no word in it", async () => {
    const matches = await run(
      Effect.flatMap(memory, (service) => service.search({ id: ASSISTANT, text: "!!" })),
    );
    expect(matches).toEqual([]);
  });
});

describe("the scope of a caller", () => {
  const readCore = (id: string) =>
    Effect.flatMap(memory, (service) => service.read({ id, name: "core" }));

  it("resolves me to a session's own assistant", async () => {
    const document = await runAs(
      buildSession(ASSISTANT),
      Effect.gen(function* () {
        const service = yield* memory;
        yield* service.write({ id: "me", name: "core", body: "mine" });
        return yield* service.read({ id: ASSISTANT, name: "core" });
      }),
    );
    expect(document.body).toBe("mine");
  });

  it("lets a session name its own assistant by id", async () => {
    expect((await runAs(buildSession(ASSISTANT), readCore(ASSISTANT))).name).toBe("core");
  });

  it("refuses a session naming another assistant, with the operation's grant", async () => {
    const read = await runErrorAs(buildSession(ASSISTANT), readCore(OTHER_ASSISTANT));
    expect(read).toMatchObject({ error: { code: "forbidden", details: { grant: "memory.read" } } });

    const write = await runErrorAs(
      buildSession(ASSISTANT),
      Effect.flatMap(memory, (service) =>
        service.write({ id: OTHER_ASSISTANT, name: "core", body: "x" }),
      ),
    );
    expect(write).toMatchObject({
      error: { code: "forbidden", details: { grant: "memory.write" } },
    });
  });

  it("refuses a session naming another assistant's topic before saying whether it exists", async () => {
    const error = await runErrorAs(
      buildSession(ASSISTANT),
      Effect.flatMap(memory, (service) =>
        service.read({ id: OTHER_ASSISTANT, name: "no such topic" }),
      ),
    );
    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });

  it("refuses me from the user, from a session outside a conversation and from a run", async () => {
    for (const actor of [USER, buildSession(null), RUN]) {
      const error = await runErrorAs(actor, readCore("me"));
      expect(error).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["id"] }] } },
      });
    }
  });

  it("lets the user reach any assistant by id", async () => {
    expect((await run(readCore(OTHER_ASSISTANT))).name).toBe("core");
  });
});
