/**
 * Tests how a save updates the trigger rows of a workflow, and how the trigger
 * list is paged.
 *
 * One save writes all of a workflow's triggers with the same `created_at`, so
 * `created_at` alone does not give a stable order. The list query also sorts by
 * workflow id and trigger id, and the cursor holds all three values. Without
 * them, a page that ends among rows with the same `created_at` would skip or
 * repeat rows on the next page.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Trigger } from "@hercule/contract";
import { TestDatabase } from "../db/testing";
import { workflowRepository, type DeclaredTrigger } from "./repository";

const FIRST_SAVE = "2026-09-22T10:00:00.000Z";
const SECOND_SAVE = "2026-09-22T11:00:00.000Z";

/** Returns a start trigger on `task.created`, with `fields` replacing the defaults. */
const declareTrigger = (
  triggerId: string,
  fields: Partial<DeclaredTrigger> = {},
): DeclaredTrigger => ({
  triggerId,
  kind: "start",
  eventKind: "task.created",
  connectionId: undefined,
  filter: undefined,
  schedule: undefined,
  timezone: undefined,
  ...fields,
});

/** Inserts a workflow and its triggers, all saved at `savedAt`. Returns the workflow id. */
const storeWorkflow = (name: string, triggers: ReadonlyArray<DeclaredTrigger>, savedAt: string) =>
  Effect.gen(function* () {
    const workflows = yield* workflowRepository;
    const stored = yield* workflows.insert(
      { source: `name: ${name}\nsteps: []\n`, definition: { name, steps: [] } },
      savedAt,
    );
    yield* workflows.reconcileTriggers(stored.id, triggers, savedAt);
    return stored.id;
  });

/** Lists every trigger row in one page. Returns a map from trigger id to row. */
const readTriggers = Effect.gen(function* () {
  const workflows = yield* workflowRepository;
  const page = yield* workflows.listTriggers({
    limit: 100,
    cursor: undefined,
    direction: "desc",
    workflowId: undefined,
    kind: undefined,
    eventKind: undefined,
    status: undefined,
  });
  return new Map(page.items.map((item) => [item.triggerId, item]));
});

/**
 * Saves a workflow with the triggers in `before`, then saves it again an hour
 * later with the triggers in `after`. The triggers listed in `pausedIds` are
 * paused between the two saves. Returns the trigger rows after the second
 * save, keyed by trigger id.
 */
const saveTwice = (
  before: ReadonlyArray<DeclaredTrigger>,
  after: ReadonlyArray<DeclaredTrigger>,
  pausedIds: ReadonlyArray<string> = [],
): Promise<ReadonlyMap<string, Trigger>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const workflows = yield* workflowRepository;
      const sql = yield* SqlClient.SqlClient;
      const workflowId = yield* storeWorkflow("Twice saved", before, FIRST_SAVE);
      for (const triggerId of pausedIds) {
        yield* sql`UPDATE triggers SET status = 'paused' WHERE trigger_id = ${triggerId}`;
      }
      yield* workflows.reconcileTriggers(workflowId, after, SECOND_SAVE);
      return yield* readTriggers;
    }).pipe(Effect.provide(TestDatabase), Effect.orDie),
  );

describe("saving a workflow's triggers a second time", () => {
  it("leaves the row of an unchanged trigger untouched", async () => {
    const triggers = await saveTwice([declareTrigger("a")], [declareTrigger("a")]);
    expect(triggers.get("a")).toMatchObject({ createdAt: FIRST_SAVE, updatedAt: FIRST_SAVE });
  });

  it("updates the fields and updated_at of a changed trigger, and keeps its created_at and status", async () => {
    const triggers = await saveTwice(
      [declareTrigger("a")],
      [declareTrigger("a", { filter: "event.payload.id > 3" })],
      ["a"],
    );
    expect(triggers.get("a")).toMatchObject({
      filter: "event.payload.id > 3",
      status: "paused",
      createdAt: FIRST_SAVE,
      updatedAt: SECOND_SAVE,
    });
  });

  it("gives a start trigger a status and a signal trigger no status", async () => {
    const triggers = await saveTwice(
      [],
      [declareTrigger("a"), declareTrigger("s", { kind: "signal", eventKind: "task.updated" })],
    );
    expect(triggers.get("a")?.status).toBe("active");
    expect(Object.keys(triggers.get("s") ?? {})).not.toContain("status");
  });

  it("replaces a trigger whose kind changed with a new row, even when its id is the same", async () => {
    const triggers = await saveTwice(
      [declareTrigger("a"), declareTrigger("s", { kind: "signal" })],
      [declareTrigger("a", { kind: "signal" }), declareTrigger("s")],
      ["a"],
    );
    // The paused start trigger became a signal trigger, which has no status.
    expect(triggers.get("a")).toMatchObject({ kind: "signal", createdAt: SECOND_SAVE });
    expect(Object.keys(triggers.get("a") ?? {})).not.toContain("status");
    // The signal trigger became a start trigger, which starts out active.
    expect(triggers.get("s")).toMatchObject({
      kind: "start",
      status: "active",
      createdAt: SECOND_SAVE,
    });
  });
});

describe("listing triggers page by page", () => {
  it("returns each trigger once, in order, when a page ends among triggers with the same created_at", async () => {
    const { listed, workflowIds } = await Effect.runPromise(
      Effect.gen(function* () {
        const triggers = ["a", "b", "c"].map((triggerId) => declareTrigger(triggerId));
        const workflowIds = [
          yield* storeWorkflow("First", triggers, FIRST_SAVE),
          yield* storeWorkflow("Second", triggers, FIRST_SAVE),
        ];
        const workflows = yield* workflowRepository;
        const listed: Array<readonly [string, string]> = [];
        let cursor: string | undefined;
        do {
          const page = yield* workflows.listTriggers({
            limit: 2,
            cursor,
            direction: "desc",
            workflowId: undefined,
            kind: undefined,
            eventKind: undefined,
            status: undefined,
          });
          listed.push(...page.items.map((item) => [item.workflowId, item.triggerId] as const));
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return { listed, workflowIds };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    // Workflow ids are canonical UUIDs of the same length, so comparing them as
    // strings gives the same order as the database. Joining each workflow id
    // and trigger id into one string then sorts the pairs like the list query.
    const expected = workflowIds
      .flatMap((workflowId) => ["a", "b", "c"].map((triggerId) => [workflowId, triggerId] as const))
      .sort((left, right) => (left.join(" ") < right.join(" ") ? 1 : -1));
    expect(listed).toEqual(expected);
  });
});
