/**
 * Tests the facts that keep a Task true to the things it links, through the
 * Task service on real rows:
 *
 * - what a Task's links count as (`countLinkedWork`)
 * - the facts an entity write makes (`recordEntityFactsAround`)
 * - the facts a new link and a first install make (the fact of an unlink is
 *   tested with `unlinkEntity`, in `service.link-by-hand.test.ts`)
 *
 * An entity write is played as the ingest plays it: take the snapshot, change
 * the rows, record the facts, all in one transaction.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ExternalRef } from "@hercule/contract";
import { withTransaction } from "../db";
import { readEventsOfKind } from "../events/testing";
import { TestClock } from "effect/testing";
import { TaskService } from "./index";
import {
  A_MINUTE,
  arrange,
  arrangeConnection,
  createTaskLinking,
  declareKinds,
  PLUGIN,
  pr,
  PULL_REQUEST,
  readFacts,
  REPOSITORY,
  REPOSITORY_KIND,
  run,
  setAccess,
  setLifecycle,
  writeEntities,
  type ArrangedRecord,
} from "./testing";

describe("counting a Task's linked work", () => {
  type Declared = "declared" | "removed";
  const countFor = (
    records: ReadonlyArray<ArrangedRecord>,
    links: ReadonlyArray<ExternalRef>,
    catalog: Declared,
  ) =>
    run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        if (catalog === "declared") yield* declareKinds;
        yield* arrange(...records);
        const tasks = yield* TaskService;
        const task = yield* createTaskLinking("Counted", ...links);
        return yield* tasks.countLinkedWork(task.id);
      }),
    );

  it.each<[string, ReadonlyArray<ArrangedRecord>, Declared, [number, number]]>([
    ["a ref with no record and no declared kind is neither", [], "removed", [0, 0]],
    ["a ref of a declared work kind with no record is open", [], "declared", [1, 0]],
    [
      "a partial record of a declared work kind is open",
      [{ ref: pr(1), completeness: "partial", lifecycle: "completed" }],
      "declared",
      [1, 0],
    ],
    [
      "a work record that was never read is open",
      [{ ref: pr(1), lifecycle: null, access: "none" }],
      "declared",
      [1, 0],
    ],
    [
      "a record nobody can read now is open",
      [{ ref: pr(1), lifecycle: "open", access: "inaccessible" }],
      "declared",
      [1, 0],
    ],
    [
      "completed work nobody can read now is open",
      [{ ref: pr(1), lifecycle: "completed", access: "inaccessible" }],
      "declared",
      [1, 0],
    ],
    ["completed work is completed", [{ ref: pr(1), lifecycle: "completed" }], "declared", [0, 1]],
    ["abandoned work is neither", [{ ref: pr(1), lifecycle: "abandoned" }], "declared", [0, 0]],
    [
      "a stored work record whose kind left the catalog stays counted",
      [{ ref: pr(1), lifecycle: "completed" }],
      "removed",
      [0, 1],
    ],
    [
      "a stored work record whose kind left the catalog and cannot be read is open",
      [{ ref: pr(1), lifecycle: "completed", access: "inaccessible" }],
      "removed",
      [1, 0],
    ],
  ])("%s", async (_name, records, catalog, [openLinks, completedLinks]) => {
    const counts = await countFor(records, [pr(1)], catalog);
    expect(counts).toEqual({ openLinks, completedLinks });
  });

  it("counts a thing nobody has read from a disabled plugin as open: its declared kind still holds", async () => {
    const counts = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* arrangeConnection;
        yield* declareKinds;
        yield* withTransaction(sql, sql`UPDATE plugins SET enabled = 0 WHERE id = ${PLUGIN}`);
        const tasks = yield* TaskService;
        const task = yield* createTaskLinking("Counted", pr(1));
        return yield* tasks.countLinkedWork(task.id);
      }),
    );
    expect(counts).toEqual({ openLinks: 1, completedLinks: 0 });
  });

  it("counts a context record as neither", async () => {
    const counts = await countFor(
      [{ ref: REPOSITORY, kind: REPOSITORY_KIND, lifecycle: null }],
      [REPOSITORY, pr(1)],
      "declared",
    );
    expect(counts).toEqual({ openLinks: 1, completedLinks: 0 });
  });
});

describe("the facts an entity write makes", () => {
  it("writes one fact and one event for each live Task that links a thing whose lifecycle changed", async () => {
    const { facts, events, first, second } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const first = yield* createTaskLinking("First", pr(1));
        const second = yield* createTaskLinking("Second", pr(1));
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed"));
        return {
          facts: (yield* readFacts).filter((fact) => fact.previousLifecycle === "open"),
          events: (yield* readEventsOfKind("task.entityChanged")).filter(
            (event) => event.payload["previousLifecycle"] === "open",
          ),
          first,
          second,
        };
      }),
    );
    expect(facts.map((fact) => fact.taskId)).toEqual([first.id, second.id].sort());
    expect(facts.every((fact) => fact.lifecycle === "completed" && fact.ref === pr(1))).toBe(true);
    expect(events.map((event) => event.payload)).toEqual(
      facts.map((fact) => ({
        taskId: fact.taskId,
        ref: pr(1),
        entityKind: PULL_REQUEST,
        lifecycle: "completed",
        previousLifecycle: "open",
        factId: fact.id,
        openLinks: 0,
        completedLinks: 1,
        observedAt: expect.any(String) as string,
      })),
    );
    expect(events.every((event) => event.actor === "system")).toBe(true);
  });

  it("writes nothing for a change of title, status or owner, or for a poll that changed nothing", async () => {
    const facts = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        yield* createTaskLinking("Linked", pr(1));
        const before = (yield* readFacts).length;
        yield* writeEntities(
          [pr(1)],
          sql`UPDATE external_entities
              SET title = 'Another title', status_key = 'draft', owner = 'someone-else'
              WHERE ref = ${pr(1)}`,
        );
        yield* writeEntities([pr(1)], Effect.void);
        return { before, after: (yield* readFacts).length };
      }),
    );
    expect(facts.after).toBe(facts.before);
  });

  it("writes nothing for a first sight of a thing no Task links", async () => {
    const facts = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* writeEntities([pr(1)], arrange({ ref: pr(1), lifecycle: "open" }));
        return yield* readFacts;
      }),
    );
    expect(facts).toEqual([]);
  });

  it("writes a fact with no previous lifecycle when a linked ref is observed for the first time", async () => {
    const { facts, task } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        const task = yield* createTaskLinking("Linked early", pr(1));
        yield* writeEntities([pr(1)], arrange({ ref: pr(1), lifecycle: "open" }));
        return { facts: yield* readFacts, task };
      }),
    );
    expect(facts).toEqual([
      expect.objectContaining({
        taskId: task.id,
        ref: pr(1),
        lifecycle: "open",
        previousLifecycle: null,
      }),
    ]);
  });

  it("writes nothing for a Task that is done", async () => {
    const facts = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const task = yield* createTaskLinking("Finished", pr(1));
        yield* tasks.update({ id: task.id, stage: "done" });
        const before = (yield* readFacts).length;
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed"));
        return { before, after: (yield* readFacts).length };
      }),
    );
    expect(facts.after).toBe(facts.before);
  });

  it("counts every link of the Task, whatever the kind or lifecycle", async () => {
    const events = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* declareKinds;
        yield* arrange(
          { ref: pr(1), lifecycle: "open" },
          { ref: pr(2), lifecycle: "open" },
          { ref: pr(3), lifecycle: "completed" },
          { ref: pr(4), lifecycle: "abandoned" },
          { ref: REPOSITORY, kind: REPOSITORY_KIND },
        );
        yield* createTaskLinking("Several", pr(1), pr(2), pr(3), pr(4), REPOSITORY);
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed"));
        return (yield* readEventsOfKind("task.entityChanged")).filter(
          (event) => event.payload["previousLifecycle"] === "open",
        );
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ ref: pr(1), openLinks: 1, completedLinks: 2 });
  });

  it("writes one fact when the lifecycle and the access of a thing change together", async () => {
    const facts = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        yield* createTaskLinking("Linked", pr(1));
        const before = (yield* readFacts).length;
        yield* writeEntities(
          [pr(1)],
          Effect.andThen(setLifecycle(pr(1), "completed"), setAccess(pr(1), "inaccessible")),
        );
        return (yield* readFacts).slice(before);
      }),
    );
    expect(facts).toEqual([
      expect.objectContaining({ ref: pr(1), lifecycle: "completed", previousLifecycle: "open" }),
    ]);
  });

  it("never makes a fact for a thing whose own state did not change, even when another link moved the counts", async () => {
    const facts = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "completed" }, { ref: pr(2), lifecycle: "open" });
        yield* createTaskLinking("Two", pr(1), pr(2));
        const before = (yield* readFacts).length;
        yield* writeEntities([pr(1), pr(2)], setLifecycle(pr(2), "completed"));
        return (yield* readFacts).slice(before);
      }),
    );
    expect(facts.map((fact) => fact.ref)).toEqual([pr(2)]);
  });

  it("writes a fact when a completed link that could not be read reads again with the same lifecycle", async () => {
    const { facts, events } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "completed", access: "inaccessible" });
        yield* createTaskLinking("Waiting", pr(1));
        const before = (yield* readFacts).length;
        yield* writeEntities([pr(1)], setAccess(pr(1), "ok"));
        return {
          facts: (yield* readFacts).slice(before),
          events: yield* readEventsOfKind("task.entityChanged"),
        };
      }),
    );
    expect(facts).toEqual([
      expect.objectContaining({ lifecycle: "completed", previousLifecycle: "completed" }),
    ]);
    expect(events.at(-1)!.payload).toMatchObject({ openLinks: 0, completedLinks: 1 });
  });

  it("writes nothing when a thing loses its readability and no count moves", async () => {
    const facts = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        yield* createTaskLinking("Open", pr(1));
        const before = (yield* readFacts).length;
        // Open work counts as open whether or not it can be read.
        yield* writeEntities([pr(1)], setAccess(pr(1), "inaccessible"));
        return (yield* readFacts).length - before;
      }),
    );
    expect(facts).toBe(0);
  });
});

describe("the facts a new link makes", () => {
  it("writes a fact with no previous lifecycle for a link to a thing that has a lifecycle, and none for one that has not", async () => {
    const facts = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const task = yield* createTaskLinking("Blank");
        yield* TestClock.adjust(A_MINUTE);
        yield* tasks.update({ id: task.id, provenance: [{ ref: pr(1) }, { ref: pr(2) }] });
        // Linking the same ref again is not a new link.
        yield* TestClock.adjust(A_MINUTE);
        yield* tasks.update({ id: task.id, provenance: [{ ref: pr(1) }] });
        return yield* readFacts;
      }),
    );
    expect(facts).toEqual([
      expect.objectContaining({ ref: pr(1), lifecycle: "open", previousLifecycle: null }),
    ]);
  });

  it("writes a fact for a ref a new Task is created with", async () => {
    const { facts, events } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "completed" });
        const task = yield* createTaskLinking("Born linked", pr(1));
        return {
          facts: yield* readFacts,
          events: yield* readEventsOfKind("task.entityChanged"),
          task,
        };
      }),
    );
    expect(facts).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      ref: pr(1),
      lifecycle: "completed",
      previousLifecycle: null,
      openLinks: 0,
      completedLinks: 1,
    });
  });

  it("writes no fact for a Task that is born finished", async () => {
    const facts = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        yield* tasks.create({
          title: "Done already",
          description: "",
          stage: "done",
          provenance: [{ ref: pr(1) }],
        });
        return yield* readFacts;
      }),
    );
    expect(facts).toEqual([]);
  });
});

describe("the facts of a first install", () => {
  it("writes a fact for each live link to a thing that has a lifecycle", async () => {
    const written = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskService;
        yield* arrangeConnection;
        // The links come first, so the link facts do not hide what the install writes.
        const linked = yield* createTaskLinking("Linked", pr(1), pr(2), pr(3));
        const finished = yield* createTaskLinking("Finished", pr(1));
        yield* tasks.update({ id: finished.id, stage: "done" });
        yield* arrange({ ref: pr(1), lifecycle: "open" }, { ref: pr(2), lifecycle: "completed" });
        yield* withTransaction(sql, tasks.recordFirstInstallFacts());
        return { facts: yield* readFacts, linked };
      }),
    );
    expect(written.facts).toEqual([
      expect.objectContaining({
        taskId: written.linked.id,
        ref: pr(1),
        lifecycle: "open",
        previousLifecycle: null,
      }),
      expect.objectContaining({
        taskId: written.linked.id,
        ref: pr(2),
        lifecycle: "completed",
        previousLifecycle: null,
      }),
    ]);
  });
});
