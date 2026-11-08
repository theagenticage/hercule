/**
 * Tests linking and unlinking an outside thing by hand (`linkEntity` and
 * `unlinkEntity`), through the Task service on real rows: the link and its
 * fact, an unlink that sticks, the facts an unlink voids or writes, a relink,
 * a provenance `ref` that asks for the link again, merged ids, grants, the
 * actor and what the writes announce.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { uuidFromString, uuidToString } from "../db";
import { buildAnnouncementRecorder } from "../db/testing";
import { readEventsOfKind } from "../events/testing";
import { TaskService } from "./index";
import {
  A_MINUTE,
  arrange,
  arrangeConnection,
  createTaskLinking,
  pr,
  readFacts,
  run,
  setLifecycle,
  writeEntities,
} from "./testing";

interface LinkRow {
  readonly ref: string;
  readonly linked_by: string;
}

const readLinks = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<LinkRow>`SELECT ref, linked_by FROM task_entity_links
      WHERE task_id = ${uuidFromString(taskId)} ORDER BY ref`;
  });

const readSuppressions = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly ref: string; readonly suppressed_by: string }>`
      SELECT ref, suppressed_by FROM task_entity_link_suppressions
      WHERE task_id = ${uuidFromString(taskId)} ORDER BY ref`;
  });

const readProvenanceRefs = (taskId: string) =>
  Effect.map(
    Effect.flatMap(TaskService, (tasks) => tasks.read(taskId)),
    (task) => task.provenance.flatMap((entry) => (entry.ref === undefined ? [] : [entry.ref])),
  );

/** Creates a Task with no links, a minute after the last write. */
const createBareTask = Effect.gen(function* () {
  yield* TestClock.adjust(A_MINUTE);
  const tasks = yield* TaskService;
  return yield* tasks.create({ title: "A task", description: "" });
});

const minuteLater = Effect.flatMap(TestClock.adjust(A_MINUTE), () => TaskService);

describe("linking a thing by hand", () => {
  it("adds the link, a provenance entry and a fact for a thing with a lifecycle", async () => {
    const { links, provenance, facts, updated } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
        return {
          links: yield* readLinks(task.id),
          provenance: yield* readProvenanceRefs(task.id),
          facts: yield* readFacts,
          updated: yield* readEventsOfKind("task.updated"),
        };
      }),
    );
    expect(links).toEqual([{ ref: pr(1), linked_by: "user" }]);
    expect(provenance).toEqual([pr(1)]);
    expect(facts).toMatchObject([{ ref: pr(1), lifecycle: "open", previousLifecycle: null }]);
    expect(updated).toHaveLength(1);
  });

  it("writes no fact for a thing with no lifecycle, and links a thing Hercule holds no record of", async () => {
    const { links, facts } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: null });
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
        yield* tasks.linkEntity({ id: task.id, ref: pr(2) });
        return { links: yield* readLinks(task.id), facts: yield* readFacts };
      }),
    );
    expect(links.map((link) => link.ref)).toEqual([pr(1), pr(2)]);
    expect(facts).toEqual([]);
  });

  it("changes nothing when the Task links the thing already", async () => {
    const { first, second, provenance, facts } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        const first = yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
        yield* TestClock.adjust(A_MINUTE);
        const second = yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
        return {
          first,
          second,
          provenance: yield* readProvenanceRefs(task.id),
          facts: yield* readFacts,
        };
      }),
    );
    expect(first.changed).toBe(true);
    expect(second).toEqual({ task: first.task, changed: false });
    expect(provenance).toEqual([pr(1)]);
    expect(facts).toHaveLength(1);
  });

  it("allows a second live Task on the same thing", async () => {
    const links = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const first = yield* createTaskLinking("First", pr(1));
        const second = yield* createBareTask;
        const tasks = yield* minuteLater;
        yield* tasks.linkEntity({ id: second.id, ref: pr(1) });
        return [yield* readLinks(first.id), yield* readLinks(second.id)];
      }),
    );
    expect(links.map((rows) => rows.map((row) => row.ref))).toEqual([[pr(1)], [pr(1)]]);
  });

  it("links a finished Task but writes no fact for it", async () => {
    const { links, facts } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        yield* tasks.update({ id: task.id, stage: "done" });
        yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
        return { links: yield* readLinks(task.id), facts: yield* readFacts };
      }),
    );
    expect(links.map((link) => link.ref)).toEqual([pr(1)]);
    expect(facts).toEqual([]);
  });

  it("fails for a ref that is not a valid external ref, and for a Task that is not there", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        yield* tasks.delete(task.id);
        const bare = yield* createBareTask;
        return [
          yield* Effect.flip(tasks.linkEntity({ id: bare.id, ref: "not a ref" })),
          yield* Effect.flip(tasks.linkEntity({ id: task.id, ref: pr(1) })),
          yield* Effect.flip(
            tasks.linkEntity({ id: "0199e0e7-0004-7000-8000-0000000000ff", ref: pr(1) }),
          ),
        ];
      }),
    );
    expect(errors).toMatchObject([
      { error: { code: "validation" } },
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
    ]);
  });
});

describe("unlinking a thing by hand", () => {
  it("removes the link, voids the pair's facts and records the unlink, and leaves provenance alone", async () => {
    const { changed, links, provenance, suppressions, voided } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" }, { ref: pr(2), lifecycle: "open" });
        const task = yield* createTaskLinking("Linked", pr(1), pr(2)); // facts 1, 2
        const tasks = yield* minuteLater;
        const unlinked = yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
        return {
          changed: unlinked.changed,
          links: yield* readLinks(task.id),
          provenance: yield* readProvenanceRefs(task.id),
          suppressions: yield* readSuppressions(task.id),
          voided: (yield* sql<{ readonly id: number; readonly voided_at: string | null }>`
            SELECT id, voided_at FROM task_entity_facts ORDER BY id`).map(
            (fact) => fact.voided_at !== null,
          ),
        };
      }),
    );
    expect(changed).toBe(true);
    expect(links.map((link) => link.ref)).toEqual([pr(2)]);
    expect(provenance).toEqual([pr(1), pr(2)]);
    expect(suppressions).toEqual([{ ref: pr(1), suppressed_by: "user" }]);
    expect(voided).toEqual([true, false]);
  });

  it("changes nothing for a thing the Task does not link", async () => {
    const { before, after, suppressions } = await run(
      Effect.gen(function* () {
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        const before = yield* tasks.read(task.id);
        const after = yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
        return { before, after, suppressions: yield* readSuppressions(task.id) };
      }),
    );
    expect(after).toEqual({ task: before, changed: false });
    expect(suppressions).toEqual([]);
  });

  it("writes the landing fact when the last open link goes and something completed", async () => {
    const facts = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "completed" }, { ref: pr(2), lifecycle: "open" });
        const task = yield* createTaskLinking("Mixed", pr(1), pr(2)); // facts 1, 2
        const tasks = yield* minuteLater;
        yield* tasks.unlinkEntity({ id: task.id, ref: pr(2) });
        return yield* readFacts;
      }),
    );
    expect(facts.map((fact) => [fact.ref, fact.lifecycle, fact.previousLifecycle])).toEqual([
      [pr(1), "completed", null],
      [pr(2), "open", null],
      [pr(1), "completed", "completed"],
    ]);
  });

  it("writes the landing fact for the newest of several completed links", async () => {
    const facts = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(
          { ref: pr(1), lifecycle: "completed" },
          { ref: pr(2), lifecycle: "completed" },
          { ref: pr(3), lifecycle: "open" },
        );
        const task = yield* createTaskLinking("Several", pr(1)); // fact 1
        yield* (yield* minuteLater).linkEntity({ id: task.id, ref: pr(2) }); // fact 2
        yield* (yield* minuteLater).linkEntity({ id: task.id, ref: pr(3) }); // fact 3
        yield* (yield* minuteLater).unlinkEntity({ id: task.id, ref: pr(3) });
        return yield* readFacts;
      }),
    );
    expect(facts.map((fact) => [fact.ref, fact.lifecycle, fact.previousLifecycle]).at(-1)).toEqual([
      pr(2),
      "completed",
      "completed",
    ]);
    expect(facts).toHaveLength(4);
  });

  it("writes no landing fact while something is still open, or when nothing completed", async () => {
    const counts = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(
          { ref: pr(1), lifecycle: "completed" },
          { ref: pr(2), lifecycle: "open" },
          { ref: pr(3), lifecycle: "open" },
          { ref: pr(4), lifecycle: "open" },
        );
        const stillOpen = yield* createTaskLinking("Still open", pr(1), pr(2), pr(3)); // facts 1 to 3
        const nothingDone = yield* createTaskLinking("Nothing done", pr(4)); // fact 4
        const tasks = yield* minuteLater;
        yield* tasks.unlinkEntity({ id: stillOpen.id, ref: pr(2) });
        yield* tasks.unlinkEntity({ id: nothingDone.id, ref: pr(4) });
        return (yield* readFacts).length;
      }),
    );
    expect(counts).toBe(4);
  });

  it("makes a fact queued before the unlink do nothing, even when the thing is linked again first", async () => {
    const { afterUnlink, afterRelink, afterNewFact } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const task = yield* createTaskLinking("Linked", pr(1), pr(2)); // fact 1
        yield* writeEntities([pr(1)], setLifecycle(pr(1), "completed")); // fact 2
        const tasks = yield* minuteLater;
        yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
        const queued = (key: number) =>
          Effect.flatMap(minuteLater, (service) =>
            service.update({ id: task.id, stage: "in-review", stageFactId: key }),
          );
        const afterUnlink = (yield* queued(2)).stage;
        yield* tasks.linkEntity({ id: task.id, ref: pr(1) }); // fact 3
        const afterRelink = (yield* queued(2)).stage;
        const afterNewFact = (yield* queued(3)).stage;
        return { afterUnlink, afterRelink, afterNewFact };
      }),
    );
    expect(afterUnlink).toBe("planned");
    expect(afterRelink).toBe("planned");
    expect(afterNewFact).toBe("in-review");
  });
});

describe("an unlink that sticks", () => {
  it("is cleared by linking by hand, and a new fact applies afterwards", async () => {
    const { whileUnlinked, afterLink, facts } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const task = yield* createTaskLinking("Linked", pr(1));
        const tasks = yield* minuteLater;
        yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
        const whileUnlinked = yield* readSuppressions(task.id);
        yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
        return {
          whileUnlinked,
          afterLink: yield* readSuppressions(task.id),
          facts: yield* readFacts,
        };
      }),
    );
    expect(whileUnlinked).toHaveLength(1);
    expect(afterLink).toEqual([]);
    expect(facts.map((fact) => fact.previousLifecycle)).toEqual([null, null]);
  });

  it("is cleared by a provenance ref on task.update, which is asking for the link", async () => {
    const afterUpdate = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        const task = yield* createTaskLinking("Linked", pr(1));
        const tasks = yield* minuteLater;
        yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
        yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
        yield* tasks.update({ id: task.id, provenance: [{ ref: pr(1) }] });
        return {
          suppressions: yield* readSuppressions(task.id),
          links: (yield* readLinks(task.id)).map((link) => link.ref),
        };
      }),
    );
    expect(afterUpdate).toEqual({ suppressions: [], links: [pr(1)] });
  });
});

describe("a merged Task", () => {
  it("takes the link and the unlink on its survivor", async () => {
    const { survivorLinks, afterUnlink, suppressions } = await run(
      Effect.gen(function* () {
        const source = yield* createBareTask;
        const survivor = yield* createBareTask;
        const tasks = yield* minuteLater;
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        yield* tasks.linkEntity({ id: source.id, ref: pr(1) });
        const survivorLinks = (yield* readLinks(survivor.id)).map((link) => link.ref);
        const unlinked = yield* tasks.unlinkEntity({ id: source.id, ref: pr(1) });
        return {
          survivorLinks,
          afterUnlink: unlinked.task.id === survivor.id,
          suppressions: yield* readSuppressions(survivor.id),
        };
      }),
    );
    expect(survivorLinks).toEqual([pr(1)]);
    expect(afterUnlink).toBe(true);
    expect(suppressions).toMatchObject([{ ref: pr(1) }]);
  });
});

describe("who may link and unlink, and what they announce", () => {
  const withoutGrant: Actor = {
    _tag: "session",
    sessionId: "0199e0e7-0002-7000-8000-000000000000",
    grants: ["task.read"],
    profileGrants: ["task.read"],
    assistantId: null,
    agentId: null,
  } as unknown as Actor;

  const sessionActor: Actor = {
    ...withoutGrant,
    grants: ["task.read", "task.update"],
    profileGrants: ["task.read", "task.update"],
  } as unknown as Actor;

  it("refuses a caller without the grant task.update", async () => {
    const errors = await run(
      Effect.gen(function* () {
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        const asSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(Effect.flip(effect), CurrentActor, withoutGrant);
        return [
          yield* asSession(tasks.linkEntity({ id: task.id, ref: pr(1) })),
          yield* asSession(tasks.unlinkEntity({ id: task.id, ref: pr(1) })),
        ];
      }),
    );
    expect(errors).toMatchObject([
      { error: { code: "forbidden" } },
      { error: { code: "forbidden" } },
    ]);
  });

  it("stamps the caller on the link and on the unlink record", async () => {
    const { links, suppressions } = await run(
      Effect.gen(function* () {
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        yield* Effect.provideService(
          Effect.gen(function* () {
            yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
            yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
          }),
          CurrentActor,
          sessionActor,
        );
        return { links: yield* readLinks(task.id), suppressions: yield* readSuppressions(task.id) };
      }),
    );
    expect(links).toEqual([]);
    expect(suppressions).toEqual([
      { ref: pr(1), suppressed_by: "session:0199e0e7-0002-7000-8000-000000000000" },
    ]);
  });

  it("announces the task, plainly, and the thing's record for a link and for an unlink", async () => {
    const { listener, announced } = buildAnnouncementRecorder();
    const { taskId, entityId, afterLink, afterUnlink } = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* arrangeConnection;
        yield* arrange({ ref: pr(1), lifecycle: "open" });
        const [row] = yield* sql<{ readonly id: Uint8Array }>`
          SELECT id FROM external_entities WHERE ref = ${pr(1)}`;
        const task = yield* createBareTask;
        const tasks = yield* minuteLater;
        const [afterLink, afterUnlink] = yield* Effect.provide(
          Effect.gen(function* () {
            const start = announced.length;
            yield* tasks.linkEntity({ id: task.id, ref: pr(1) });
            const middle = announced.length;
            yield* tasks.unlinkEntity({ id: task.id, ref: pr(1) });
            return [announced.slice(start, middle), announced.slice(middle)] as const;
          }),
          listener,
        );
        return { taskId: task.id, entityId: uuidToString(row!.id), afterLink, afterUnlink };
      }),
    );
    for (const changes of [afterLink, afterUnlink]) {
      expect(changes).toContainEqual({
        _tag: "record",
        topic: "task",
        id: taskId,
        kind: "updated",
      });
      expect(changes).toContainEqual({
        _tag: "record",
        topic: "externalEntity",
        id: entityId,
        kind: "updated",
      });
    }
  });
});
