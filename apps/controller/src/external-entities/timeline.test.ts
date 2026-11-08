/**
 * Tests what a timeline treats as news and how a stored change reads:
 *
 * - `detectSourceChanges`: which updates of an existing entity are news
 * - `renderEntityChange`: the words, from the kind's templates or the core's
 *   own, and the cut to the bound of a sentence
 * - the words of a link, worked out at read time from what the user can open
 * - the stored list: one insert per call, the cap of 50 per ref, the newest
 *   change of many refs in one read
 *
 * What a reconcile or a refresh writes on a timeline is tested beside the
 * repository, in `repository.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_ENTITY_REASON_LENGTH, MAX_ENTITY_TIMELINE } from "@hercule/contract";
import { inTransaction, TestDatabase } from "../db/testing";
import {
  detectSourceChanges,
  renderEntityChange,
  timelineRepository,
  type EntityChangeRecord,
} from "./timeline";

const status = (label: string) => JSON.stringify({ shape: "dot", tone: "quiet", label });

const detect = (
  existing: {
    completeness: "full" | "partial";
    owner: string | null;
    status: string | null;
    status_key: string | null;
  },
  changes: Record<string, string | null>,
  incomingIsPartial = false,
) =>
  detectSourceChanges({
    ref: "acme:ticket:t1",
    existing,
    incomingIsPartial,
    changes,
  });

describe("detectSourceChanges", () => {
  const full = {
    completeness: "full",
    owner: "Mei",
    status: status("Open"),
    status_key: "open",
  } as const;

  it("reports a new owner as reassigned to that person", () => {
    expect(detect(full, { owner: "Kofi" })).toEqual([
      { ref: "acme:ticket:t1", reason: "reassigned", person: "Kofi" },
    ]);
  });

  it("reports a thing that had no owner and now has one", () => {
    expect(detect({ ...full, owner: null }, { owner: "Kofi" })).toHaveLength(1);
  });

  it("reports a different status key as moved to the new word", () => {
    expect(detect(full, { status_key: "in_review", status: status("In review") })).toEqual([
      { ref: "acme:ticket:t1", reason: "moved", value: "In review" },
    ]);
  });

  it("reports an owner and a status change together, owner first", () => {
    const found = detect(full, { owner: "Kofi", status_key: "done", status: status("Done") });
    expect(found.map((change) => change.reason)).toEqual(["reassigned", "moved"]);
  });

  it("reports a cleared owner as reassigned to no one", () => {
    expect(detect(full, { owner: null })).toEqual([
      { ref: "acme:ticket:t1", reason: "reassigned" },
    ]);
  });

  it.each([
    { name: "an update that clears the status", changes: { status_key: null, status: null } },
    {
      name: "a status key that stays while its word is renamed",
      changes: { status: status("Open (renamed)") },
    },
    {
      name: "a status that only changes its tone",
      changes: { status: JSON.stringify({ shape: "dot", tone: "attention", label: "Open" }) },
    },
    { name: "an update of other columns", changes: { title: "A new title" } },
  ])("reports nothing for $name", ({ changes }) => {
    expect(detect(full, changes)).toEqual([]);
  });

  it("reports nothing for a cleared owner when the thing had none", () => {
    expect(detect({ ...full, owner: null }, { owner: null })).toEqual([]);
  });

  it("reports a different key even when the new word equals the old word", () => {
    expect(detect(full, { status_key: "reopened" })).toEqual([
      { ref: "acme:ticket:t1", reason: "moved", value: "Open" },
    ]);
  });

  it("reports nothing for a thing that had no status before", () => {
    expect(
      detect({ ...full, status_key: null }, { status_key: "open", status: status("Open") }),
    ).toEqual([]);
  });

  it("reports nothing when a full observation completes a partial record", () => {
    const partial = {
      completeness: "partial",
      owner: null,
      status: status("Open"),
      status_key: "open",
    } as const;
    expect(detect(partial, { owner: "Kofi", status_key: "done", status: status("Done") })).toEqual(
      [],
    );
  });

  it("reports a status change of a partial record that a partial observation updates", () => {
    const partial = {
      completeness: "partial",
      owner: null,
      status: status("Open"),
      status_key: "open",
    } as const;
    expect(detect(partial, { status_key: "done", status: status("Done") }, true)).toHaveLength(1);
  });
});

describe("renderEntityChange", () => {
  const row = (
    reason: "reassigned" | "moved" | "linked",
    facts: { person?: string; value?: string },
    reasonTemplates: unknown = null,
  ) => ({
    reason,
    person: facts.person ?? null,
    value: facts.value ?? null,
    target_ref: null as string | null,
    observed_at: "2026-03-01T00:05:00.000Z",
    reason_templates: reasonTemplates === null ? null : JSON.stringify(reasonTemplates),
  });

  it.each([
    { reason: "reassigned", facts: { person: "Kofi" }, say: "Now with Kofi" },
    { reason: "moved", facts: { value: "In review" }, say: "Moved to In review" },
    { reason: "linked", facts: {}, words: "ACME-12", say: "Linked ACME-12" },
  ] as const)("says the core's default for $reason when the kind declares none", (input) => {
    expect(
      renderEntityChange(
        row(input.reason, input.facts),
        "words" in input ? input.words : undefined,
      ),
    ).toEqual({
      reason: input.reason,
      sentence: { say: input.say, tone: "plain" },
      at: "2026-03-01T00:05:00.000Z",
    });
  });

  it("says the core's own words for a cleared owner, and the kind's when it declares them", () => {
    const cleared = row("reassigned", {});
    expect(renderEntityChange(cleared).sentence).toEqual({ say: "Unassigned", tone: "plain" });
    const templates = { unassigned: { say: "Nobody has it now", tone: "attention" } };
    expect(
      renderEntityChange({ ...cleared, reason_templates: JSON.stringify(templates) }).sentence,
    ).toEqual({
      say: "Nobody has it now",
      tone: "attention",
    });
  });

  it("fills the words of a link into the kind's own sentence", () => {
    const templates = { linked: { say: "Joined to {value}", tone: "good" } };
    expect(
      renderEntityChange(row("linked", {}, templates), "a pull request you cannot open").sentence,
    ).toEqual({ say: "Joined to a pull request you cannot open", tone: "good" });
  });

  it("uses the kind's own sentence and tone for the reason", () => {
    const templates = {
      reassigned: { say: "{person} has taken it over", tone: "attention" },
      assigned: { say: "Assigned to you", tone: "plain" },
    };
    expect(renderEntityChange(row("reassigned", { person: "Kofi" }, templates)).sentence).toEqual({
      say: "Kofi has taken it over",
      tone: "attention",
    });
  });

  it("falls back to the default for a reason the kind does not declare", () => {
    const templates = { reassigned: { say: "{person} took it", tone: "attention" } };
    expect(renderEntityChange(row("moved", { value: "Done" }, templates)).sentence).toEqual({
      say: "Moved to Done",
      tone: "plain",
    });
  });

  it("falls back to the default when the kind's sentence needs a fact a change does not have", () => {
    const templates = { moved: { say: "Now #{number} is {value}", tone: "attention" } };
    expect(renderEntityChange(row("moved", { value: "Done" }, templates)).sentence).toEqual({
      say: "Moved to Done",
      tone: "plain",
    });
  });

  it("cuts a long sentence at a word to the bound of a sentence", () => {
    const person = `${"Kofi ".repeat(60)}Mensah`;
    const { say } = renderEntityChange(row("reassigned", { person })).sentence;
    expect(say.length).toBeLessThanOrEqual(MAX_ENTITY_REASON_LENGTH);
    expect(say.endsWith("…")).toBe(true);
  });
});

/** Runs `body` on a fresh migrated database, in one transaction. */
const run = <A>(
  body: (context: {
    readonly timeline: Effect.Success<typeof timelineRepository>;
    readonly sql: SqlClient.SqlClient;
  }) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const timeline = yield* timelineRepository;
      return yield* body({ timeline, sql });
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

const moved = (ref: string, value: string): EntityChangeRecord => ({ ref, reason: "moved", value });

describe("the stored timeline", () => {
  it("reads a ref's changes oldest first, and only its own", async () => {
    const read = await run(({ timeline }) =>
      Effect.gen(function* () {
        yield* timeline.recordEntityChanges(
          [moved("a", "One"), moved("b", "Other"), moved("a", "Two")],
          "2026-03-01T00:00:00.000Z",
        );
        yield* timeline.recordEntityChanges([moved("a", "Three")], "2026-03-01T00:01:00.000Z");
        return yield* timeline.readTimeline("a");
      }),
    );
    expect(read.map((change) => change.sentence.say)).toEqual([
      "Moved to One",
      "Moved to Two",
      "Moved to Three",
    ]);
    expect(read.map((change) => change.at)).toEqual([
      "2026-03-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-03-01T00:01:00.000Z",
    ]);
  });

  it("keeps the newest 50 changes of each ref it writes, and leaves other refs alone", async () => {
    const outcome = await run(({ timeline }) =>
      Effect.gen(function* () {
        yield* timeline.recordEntityChanges(
          Array.from({ length: 49 }, (_, index) => moved("full", `S${index}`)),
          "2026-03-01T00:00:00.000Z",
        );
        yield* timeline.recordEntityChanges(
          Array.from({ length: 7 }, (_, index) => moved("full", `T${index}`)),
          "2026-03-01T00:01:00.000Z",
        );
        yield* timeline.recordEntityChanges([moved("other", "Done")], "2026-03-01T00:02:00.000Z");
        return {
          full: yield* timeline.readTimeline("full"),
          other: yield* timeline.readTimeline("other"),
        };
      }),
    );
    expect(MAX_ENTITY_TIMELINE).toBe(50);
    expect(outcome.full).toHaveLength(50);
    // The six oldest went: S0 to S5.
    expect(outcome.full[0]!.sentence.say).toBe("Moved to S6");
    expect(outcome.full.at(-1)!.sentence.say).toBe("Moved to T6");
    expect(outcome.other).toHaveLength(1);
  });

  it("writes a batch of changes with two statements however many refs it holds", async () => {
    const statements: Array<string> = [];
    await run(({ timeline }) =>
      timeline
        .recordEntityChanges(
          Array.from({ length: 30 }, (_, index) => moved(`ref-${index}`, "Done")),
          "2026-03-01T00:00:00.000Z",
        )
        .pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          ),
        ),
    );
    expect(statements).toHaveLength(2);
  });

  it("reads the newest change of many refs in one statement, and none for a ref without one", async () => {
    const statements: Array<string> = [];
    const latest = await run(({ timeline }) =>
      Effect.gen(function* () {
        yield* timeline.recordEntityChanges(
          [moved("a", "One"), moved("b", "Other"), moved("a", "Two")],
          "2026-03-01T00:00:00.000Z",
        );
        return yield* timeline.readLatestChanges(["a", "b", "quiet"]).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          ),
        );
      }),
    );
    expect(statements).toHaveLength(1);
    expect(new Map([...latest].map(([ref, change]) => [ref, change.sentence.say]))).toEqual(
      new Map([
        ["a", "Moved to Two"],
        ["b", "Moved to Other"],
      ]),
    );
  });

  it("stores the ref of the linked thing on a linked change, and gives none to the others", async () => {
    const read = await run(({ timeline }) =>
      Effect.gen(function* () {
        yield* timeline.recordEntityChanges(
          [{ ref: "a", reason: "linked", targetRef: "acme:pr:12" }, moved("a", "Done")],
          "2026-03-01T00:00:00.000Z",
        );
        return yield* timeline.readTimeline("a");
      }),
    );
    expect(read.map((change) => change.ref)).toEqual(["acme:pr:12", undefined]);
  });

  it("stores no words for a link, so the stored row names nothing", async () => {
    const rows = await run(({ timeline, sql }) =>
      Effect.gen(function* () {
        yield* timeline.recordLinks(
          [{ fromRef: "a", toRef: "acme:pr:12" }],
          "2026-03-01T00:00:00.000Z",
        );
        return yield* sql<{ readonly ref: string; readonly value: string | null }>`
          SELECT ref, value FROM external_entity_timeline ORDER BY id`;
      }),
    );
    expect(rows).toEqual([
      { ref: "a", value: null },
      { ref: "acme:pr:12", value: null },
    ]);
  });

  it("names a linked thing with no record by the noun of the active kind that owns its ref, else as a thing, reading them in two statements", async () => {
    const kinds = [
      { kind: "acme/pull-request", noun: "Pull request", refPrefix: "acme:pr:" },
      { kind: "acme/issue", noun: "Issue", refPrefix: "acme:issue:" },
    ];
    const statements: Array<string> = [];
    const outcome = await run(({ timeline }) =>
      Effect.gen(function* () {
        yield* timeline.recordEntityChanges(
          [
            { ref: "a", reason: "linked", targetRef: "acme:pr:12" },
            { ref: "a", reason: "linked", targetRef: "acme:issue:4" },
            { ref: "a", reason: "linked", targetRef: "other:thing:9" },
          ],
          "2026-03-01T00:00:00.000Z",
        );
        const withKinds = yield* timeline.readTimeline("a", kinds).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          ),
        );
        return { withKinds, withoutKinds: yield* timeline.readTimeline("a") };
      }),
    );
    expect(outcome.withKinds.map((change) => change.sentence.say)).toEqual([
      "Linked a pull request you cannot open",
      "Linked an issue you cannot open",
      "Linked a thing you cannot open",
    ]);
    expect(outcome.withoutKinds.map((change) => change.sentence.say)).toEqual([
      "Linked a thing you cannot open",
      "Linked a thing you cannot open",
      "Linked a thing you cannot open",
    ]);
    // The timeline itself, the records and the observations of the linked things.
    expect(statements).toHaveLength(3);
  });

  it("deletes the changes of refs that have no entity", async () => {
    const left = await run(({ timeline, sql }) =>
      Effect.gen(function* () {
        yield* timeline.recordEntityChanges([moved("gone", "Done")], "2026-03-01T00:00:00.000Z");
        const deleted = yield* timeline.deleteOrphanedChanges();
        const rows = yield* sql`SELECT id FROM external_entity_timeline`;
        return { deleted, remaining: rows.length };
      }),
    );
    expect(left).toEqual({ deleted: 1, remaining: 0 });
  });
});
