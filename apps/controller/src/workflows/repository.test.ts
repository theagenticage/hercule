/**
 * Trigger rows: what a save does to the rows of the triggers a source keeps,
 * drops, adds or changes, and the listing across pages.
 *
 * A save writes all of a workflow's triggers at one instant, so `created_at`
 * alone does not order them: the walk also orders by the workflow and the
 * trigger id, and a cursor has to carry all three for the next page to start
 * where the last one ended.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Trigger } from "@hercule/contract";
import { TestDatabase } from "../db/testing";
import { workflowRepository, type DeclaredTrigger } from "./repository";

const FIRST_SAVE = "2026-09-22T10:00:00.000Z";
const SECOND_SAVE = "2026-09-22T11:00:00.000Z";

/** A start trigger on task creation, with the fields a case changes given. */
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

/** One workflow and its triggers, all written at the instant given. */
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

/** Every trigger row, by its id, in one page. */
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
 * The trigger rows after a first save of `before` and a second save of
 * `after` an hour later. Every trigger in `before` whose id `pausedIds` holds
 * is paused between the two saves.
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

describe("saving a source again", () => {
  it("leaves the row of a trigger whose fields did not change as it was", async () => {
    const triggers = await saveTwice([declareTrigger("a")], [declareTrigger("a")]);
    expect(triggers.get("a")).toMatchObject({ createdAt: FIRST_SAVE, updatedAt: FIRST_SAVE });
  });

  it("moves updated_at, and only updated_at, of a trigger whose fields changed", async () => {
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

  it("gives a start trigger a status and a signal trigger none", async () => {
    const triggers = await saveTwice(
      [],
      [declareTrigger("a"), declareTrigger("s", { kind: "signal", eventKind: "task.updated" })],
    );
    expect(triggers.get("a")?.status).toBe("active");
    expect(Object.keys(triggers.get("s") ?? {})).not.toContain("status");
  });

  it("makes a trigger whose kind changed a new trigger, whatever its id", async () => {
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

describe("listing the triggers page by page", () => {
  it("answers each trigger once, in order, when a page ends among triggers written at one instant", async () => {
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

    // A canonical id sorts as text the way its bytes sort in the column, and
    // every id has the same length, so the joined pair sorts as the walk does.
    const expected = workflowIds
      .flatMap((workflowId) => ["a", "b", "c"].map((triggerId) => [workflowId, triggerId] as const))
      .sort((left, right) => (left.join(" ") < right.join(" ") ? 1 : -1));
    expect(listed).toEqual(expected);
  });
});
