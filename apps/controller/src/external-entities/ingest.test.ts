/**
 * Tests what a plugin's poll may report, through `ExternalEntityIngest`, on a
 * migrated database. The plugin is an invented tracker with tickets (a fast
 * kind with cards) and projects (a place with no card).
 *
 * - what is refused, and that a refusal writes nothing
 * - what a poll writes and announces, and that a poll that changes nothing
 *   writes one row and announces nothing
 * - what is recognized in the addresses and texts of a call, and when
 */
import { describe, expect, it } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import type { Signal } from "@hercule/contract";
import * as SqlClient from "effect/sql/SqlClient";
import {
  MAX_ENTITY_OBSERVATIONS,
  MAX_ENTITY_TEXT_LENGTH,
  type EntityObservation,
  type EntityRecognition,
  type PluginError,
  type QualifiedEntityKindDeclaration,
} from "@hercule/plugin-host";
import { ConnectionNotIngesting } from "../connections";
import { uuidFromString, uuidToString } from "../db";
import { buildAnnouncementRecorder, inTransaction } from "../db/testing";
import type { EntityReporter, RecognizeText } from "../plugins";
import { signalRepository } from "../signals/repository";
import { taskRepository } from "../tasks";
import { TaskTestLayer } from "../tasks/testing";
import { ExternalEntityIngest, ExternalEntityIngestLayer } from "./ingest";
import type { FullEntityObservation } from "./slots";

type Ingest = typeof ExternalEntityIngest.Service;

const PLUGIN = "acme-tracker";
const CONNECTION = "0190c000-0000-7000-8000-0000000000a1";
const TICKET_PREFIX = "acme-tracker:ticket:";

const TICKET_KIND: QualifiedEntityKindDeclaration = {
  word: "acme-tracker/ticket",
  noun: "Ticket",
  refPrefix: TICKET_PREFIX,
  pace: "fast",
  patience: 24,
  identifier: "{key}",
  person: null,
  owner: null,
  status: null,
  facts: [],
  reasons: {},
};

const PROJECT_KIND: QualifiedEntityKindDeclaration = {
  word: "acme-tracker/project",
  noun: "Project",
  refPrefix: "acme-tracker:project:",
  pace: "context",
  patience: 0,
  identifier: "{key}",
  person: null,
  owner: null,
  status: null,
  facts: [],
  reasons: {},
  groupable: { caption: "Tracker project" },
};

const reporter: EntityReporter = {
  connectionId: CONNECTION,
  pluginId: PLUGIN,
  kinds: [TICKET_KIND, PROJECT_KIND],
};

const ticketRef = (name: string) => `${TICKET_PREFIX}${name}`;

/** Builds a full observation of a ticket that concerns the user. */
const ticket = (
  name: string,
  overrides: Partial<FullEntityObservation> = {},
): FullEntityObservation => ({
  kind: "ticket",
  ref: ticketRef(name),
  title: `Ticket ${name}`,
  url: `https://tracker.example/${name}`,
  lifecycle: "open",
  fields: { key: name.toUpperCase() },
  concerns: ["assigned"],
  sourceUpdatedAt: "2026-03-01T10:00:00Z",
  ...overrides,
});

const complete = (observations: ReadonlyArray<EntityObservation>) => ({
  kind: "ticket",
  complete: true,
  observations,
});

/** Runs `body` on a fresh migrated database that holds one plugin and one connected Connection. */
const run = <A>(
  body: (context: {
    readonly ingest: Ingest;
    readonly sql: SqlClient.SqlClient;
    readonly announced: ReadonlyArray<unknown>;
  }) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) => {
  const { listener, announced } = buildAnnouncementRecorder();
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ingest = yield* ExternalEntityIngest;
      yield* inTransaction(
        Effect.gen(function* () {
          const at = "2026-03-01T00:00:00.000Z";
          yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
            VALUES (${PLUGIN}, 1, '{}', ${at}, ${at})`;
          yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
              status, labels, config, created_at, updated_at)
            VALUES (${uuidFromString(CONNECTION)}, ${PLUGIN}, ${`${PLUGIN}/account`}, 'work', 'work',
              'work', 'connected', '[]', '{}', ${at}, ${at})`;
        }),
      );
      return yield* body({ ingest, sql, announced });
    }).pipe(
      Effect.provide(ExternalEntityIngestLayer.pipe(Layer.provideMerge(TaskTestLayer))),
      Effect.provide(listener),
      Effect.orDie,
    ),
  );
};

const countRows = (sql: SqlClient.SqlClient, table: string) =>
  Effect.map(
    sql.unsafe<{ readonly n: number }>(`SELECT count(*) AS n FROM ${table}`),
    (rows) => rows[0]!.n,
  );

/** Counts what a poll could have written, to show that a refused call wrote none of it. */
const countWrittenRows = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    return {
      entities: yield* countRows(sql, "external_entities"),
      observations: yield* countRows(sql, "external_entity_observations"),
      scans: yield* countRows(sql, "external_entity_scans"),
    };
  });

/** Reads every row an unchanged poll must leave as it was. */
const snapshotRows = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    return {
      entities: yield* sql`SELECT * FROM external_entities ORDER BY ref`,
      observations: yield* sql`SELECT * FROM external_entity_observations ORDER BY ref`,
      claims: yield* sql`SELECT * FROM external_entity_relation_claims ORDER BY id`,
    };
  });

const readEntityId = (sql: SqlClient.SqlClient, ref: string) =>
  Effect.map(
    sql<{ readonly id: Uint8Array }>`SELECT id FROM external_entities WHERE ref = ${ref}`,
    (rows) => uuidToString(rows[0]!.id),
  );

const NOTHING_WRITTEN = { entities: 0, observations: 0, scans: 0 };

describe("a call that breaks a rule of the contract", () => {
  const withoutUrlAndLifecycle: FullEntityObservation = {
    kind: "ticket",
    ref: ticketRef("bare"),
    title: "Ticket bare",
    fields: { key: "BARE" },
    concerns: ["assigned"],
    sourceUpdatedAt: "2026-03-01T10:00:00Z",
  };

  it.each([
    {
      name: "an undeclared kind",
      call: (ingest: Ingest) =>
        ingest.reconcile(reporter, { kind: "bug", complete: true, observations: [] }),
      message: 'did not declare the entity kind "bug"',
    },
    {
      name: "a kind other than the inventory's",
      call: (ingest: Ingest) =>
        ingest.reconcile(
          reporter,
          complete([
            ticket("ok"),
            {
              kind: "project",
              ref: "acme-tracker:project:harbour",
              title: "Harbour",
              fields: { key: "HARBOUR" },
              concerns: [],
              sourceUpdatedAt: "2026-03-01T10:00:00Z",
            },
          ]),
        ),
      message: 'the inventory is of "ticket"',
    },
    {
      name: "a ref that fails the refPrefix of its kind",
      call: (ingest: Ingest) =>
        ingest.reconcile(
          reporter,
          complete([ticket("ok"), ticket("bad", { ref: "other:ticket:bad" })]),
        ),
      message: `must start with "${TICKET_PREFIX}"`,
    },
    {
      name: "the same ref twice",
      call: (ingest: Ingest) => ingest.reconcile(reporter, complete([ticket("a"), ticket("a")])),
      message: "appears twice",
    },
    {
      name: "the concern following",
      call: (ingest: Ingest) =>
        ingest.reconcile(
          reporter,
          complete([ticket("ok"), ticket("bad", { concerns: ["following"] })]),
        ),
      message: "set by the core",
    },
    {
      name: "a concern on a place",
      call: (ingest: Ingest) =>
        ingest.reconcile(reporter, {
          kind: "project",
          complete: true,
          observations: [
            {
              kind: "project",
              ref: "acme-tracker:project:harbour",
              title: "Harbour",
              fields: { key: "HARBOUR" },
              concerns: ["assigned"],
              sourceUpdatedAt: "2026-03-01T10:00:00Z",
            },
          ],
        }),
      message: "a place concerns no one",
    },
    {
      name: "a full observation without url and lifecycle",
      call: (ingest: Ingest) =>
        ingest.reconcile(reporter, complete([ticket("ok"), withoutUrlAndLifecycle])),
      message: "needs url and lifecycle",
    },
    {
      name: "an oversized field",
      call: (ingest: Ingest) =>
        ingest.reconcile(
          reporter,
          complete([ticket("ok"), ticket("bad", { fields: { key: "x".repeat(600) } })]),
        ),
      message: "the observations are invalid",
    },
    {
      name: "more observations than one call takes",
      call: (ingest: Ingest) =>
        ingest.reconcile(
          reporter,
          complete(
            Array.from({ length: MAX_ENTITY_OBSERVATIONS + 1 }, (_, index) => ticket(`t${index}`)),
          ),
        ),
      message: `more than the limit of ${MAX_ENTITY_OBSERVATIONS}`,
    },
    {
      name: "an identifier template that names a field the observation lacks",
      call: (ingest: Ingest) =>
        ingest.reconcile(reporter, complete([ticket("ok"), ticket("bad", { fields: {} })])),
      message: 'needs the field "key"',
    },
    {
      name: "the concern following in a refresh",
      call: (ingest: Ingest) =>
        ingest.refresh(reporter, [ticket("ok"), ticket("bad", { concerns: ["following"] })]),
      message: "set by the core",
    },
  ])("refuses $name, with nothing written", async ({ call, message }) => {
    const { error, written } = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        const error: PluginError = yield* Effect.flip(call(ingest));
        return { error, written: yield* countWrittenRows(sql) };
      }),
    );

    expect(error._tag).toBe("PluginError");
    expect(error.message).toContain(message);
    expect(written).toEqual(NOTHING_WRITTEN);
  });

  it("refuses a missing-ref report and a wanted list for something the plugin does not own", async () => {
    const messages = await run(({ ingest }) =>
      Effect.gen(function* () {
        return {
          missing: (yield* Effect.flip(ingest.reportMissing(reporter, "other:ticket:1", "deleted")))
            .message,
          wanted: (yield* Effect.flip(ingest.listWanted(reporter, "bug", 10))).message,
        };
      }),
    );

    expect(messages.missing).toContain("no entity kind of the plugin acme-tracker owns this ref");
    expect(messages.wanted).toContain('did not declare the entity kind "bug"');
  });

  it("dies and writes nothing once the Connection is no longer ingesting", async () => {
    const { exit, written } = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        yield* inTransaction(
          sql`UPDATE connections SET status = 'disabled' WHERE id = ${uuidFromString(CONNECTION)}`,
        );
        return {
          exit: yield* Effect.exit(ingest.reconcile(reporter, complete([ticket("a")]))),
          written: yield* countWrittenRows(sql),
        };
      }),
    );

    expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(ConnectionNotIngesting);
    expect(written).toEqual(NOTHING_WRITTEN);
  });
});

describe("a poll that is accepted", () => {
  it("stores the thing and the scan, and announces the entity", async () => {
    const result = await run(({ ingest, sql, announced }) =>
      Effect.gen(function* () {
        yield* ingest.reconcile(reporter, complete([ticket("a")]));
        return {
          written: yield* countWrittenRows(sql),
          entityId: yield* readEntityId(sql, ticketRef("a")),
          announced: [...announced],
        };
      }),
    );

    expect(result.written).toEqual({ entities: 1, observations: 1, scans: 1 });
    expect(result.announced).toContainEqual({
      _tag: "record",
      topic: "externalEntity",
      id: result.entityId,
      kind: "updated",
    });
  });

  it("stores times as UTC with milliseconds", async () => {
    const stored = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        yield* ingest.reconcile(
          reporter,
          complete([ticket("a", { sourceUpdatedAt: "2026-03-01T12:00:00+02:00" })]),
        );
        return yield* sql<{ readonly source_updated_at: string }>`
          SELECT source_updated_at FROM external_entities WHERE ref = ${ticketRef("a")}`;
      }),
    );

    expect(stored[0]!.source_updated_at).toBe("2026-03-01T10:00:00.000Z");
  });

  it("writes only the scan row and announces nothing when nothing changed", async () => {
    const result = await run(({ ingest, sql, announced }) =>
      Effect.gen(function* () {
        const inventory = complete([ticket("a"), ticket("b")]);
        yield* ingest.reconcile(reporter, inventory);
        const rowsBefore = yield* snapshotRows(sql);
        const announcedBefore = announced.length;
        yield* ingest.reconcile(reporter, inventory);
        return {
          rowsBefore,
          rowsAfter: yield* snapshotRows(sql),
          announcedBefore,
          announcedAfter: announced.length,
          scans: yield* countRows(sql, "external_entity_scans"),
        };
      }),
    );

    expect(result.rowsAfter).toEqual(result.rowsBefore);
    expect(result.scans).toBe(1);
    expect(result.announcedAfter).toBe(result.announcedBefore);
  });

  it("announces the entity and a derived push for its live Task when a card changed", async () => {
    const result = await run(({ ingest, sql, announced }) =>
      Effect.gen(function* () {
        yield* ingest.reconcile(reporter, complete([ticket("a")]));
        const tasks = yield* taskRepository;
        const task = yield* inTransaction(
          tasks.insert({
            title: "Work on a",
            description: "",
            status: "open",
            stage: "planned",
            priority: "normal",
            labels: [],
            projectId: undefined,
            provenance: [{ ref: ticketRef("a") }],
            at: "2026-03-01T00:30:00.000Z",
            actor: "user",
          }),
        );
        const announcedBefore = announced.length;
        yield* ingest.reconcile(
          reporter,
          complete([
            ticket("a", { title: "Ticket a, renamed", sourceUpdatedAt: "2026-03-02T10:00:00Z" }),
          ]),
        );
        return {
          taskId: task.id,
          entityId: yield* readEntityId(sql, ticketRef("a")),
          announcedNow: announced.slice(announcedBefore),
        };
      }),
    );

    expect(result.announcedNow).toEqual([
      { _tag: "record", topic: "externalEntity", id: result.entityId, kind: "updated" },
      { _tag: "record", topic: "task", id: result.taskId, kind: "updated", derived: true },
    ]);
  });

  it("warns on the Connection when the read was incomplete, and announces the Connection", async () => {
    const result = await run(({ ingest, sql, announced }) =>
      Effect.gen(function* () {
        yield* ingest.reconcile(reporter, { ...complete([ticket("a")]), complete: false });
        return {
          warning: (yield* sql<{ readonly warning: string | null }>`
            SELECT warning FROM connections WHERE id = ${uuidFromString(CONNECTION)}`)[0]!.warning,
          announced: [...announced],
        };
      }),
    );

    expect(result.warning).toContain("The Inbox may be missing items");
    expect(result.announced).toContainEqual({
      _tag: "record",
      topic: "connection",
      id: CONNECTION,
      kind: "updated",
    });
  });
});

describe("the Connection's warning", () => {
  const harbour: FullEntityObservation = {
    kind: "project",
    ref: "acme-tracker:project:harbour",
    title: "Harbour",
    fields: { key: "HARBOUR" },
    concerns: [],
    sourceUpdatedAt: "2026-03-01T10:00:00Z",
  };
  const readWarning = (sql: SqlClient.SqlClient) =>
    Effect.map(
      sql<{ readonly warning: string | null }>`
        SELECT warning FROM connections WHERE id = ${uuidFromString(CONNECTION)}`,
      (rows) => rows[0]!.warning,
    );
  const setWarning = (sql: SqlClient.SqlClient, warning: string) =>
    inTransaction(
      sql`UPDATE connections SET warning = ${warning} WHERE id = ${uuidFromString(CONNECTION)}`,
    );

  it("clears its own warning once the kind is read completely", async () => {
    const steps = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        yield* ingest.reconcile(reporter, { ...complete([ticket("a")]), complete: false });
        const partial = yield* readWarning(sql);
        yield* ingest.reconcile(reporter, complete([ticket("a")]));
        return { partial, cleared: yield* readWarning(sql) };
      }),
    );
    expect(steps.partial).toContain("The Inbox may be missing items");
    expect(steps.cleared).toBeNull();
  });

  it.each([
    { name: "a token warning", warning: "The token expires soon" },
    {
      name: "a setup warning that starts like its own sentences",
      warning: "The Inbox scope was not granted during setup.",
    },
  ])("never overwrites or clears $name that account setup wrote", async ({ warning }) => {
    const warnings = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        yield* setWarning(sql, warning);
        yield* ingest.reconcile(reporter, { ...complete([ticket("a")]), complete: false });
        const afterIncomplete = yield* readWarning(sql);
        yield* ingest.reconcile(reporter, complete([ticket("a")]));
        return { afterIncomplete, afterComplete: yield* readWarning(sql) };
      }),
    );
    expect(warnings).toEqual({ afterIncomplete: warning, afterComplete: warning });
  });

  it("keeps the warning of one kind until that kind reads completely, whatever another kind does", async () => {
    const warnings = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        yield* ingest.reconcile(reporter, { ...complete([ticket("a")]), complete: false });
        const tickets = yield* readWarning(sql);
        const projects = { kind: "project", observations: [harbour] };
        yield* ingest.reconcile(reporter, { ...projects, complete: false });
        yield* ingest.reconcile(reporter, { ...projects, complete: true });
        const projectsRead = yield* readWarning(sql);
        yield* ingest.reconcile(reporter, complete([ticket("a")]));
        return { tickets, projectsRead, cleared: yield* readWarning(sql) };
      }),
    );
    expect(warnings.tickets).toContain("acme-tracker/ticket");
    expect(warnings.projectsRead).toBe(warnings.tickets);
    expect(warnings.cleared).toBeNull();
  });

  it("warns that a relationship was ignored when a loop was reported", async () => {
    const partOf = (ref: string) => ({ complete: true, partOf: [ref], linked: [] });
    const warning = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        yield* ingest.reconcile(
          reporter,
          complete([
            ticket("a", { relations: partOf(ticketRef("b")) }),
            ticket("b", { relations: partOf(ticketRef("a")) }),
          ]),
        );
        return yield* readWarning(sql);
      }),
    );
    expect(warning).toContain("part of itself");
  });
});

describe("the signals a new work record puts in front of Intake", () => {
  const AT = "2026-03-01T00:01:00.000Z";

  /** Raises a signal from an event on the thread `threadRef` and returns its id. */
  const raiseSignal = (id: string, threadRef: string, status: "open" | "resolved" = "open") =>
    Effect.gen(function* () {
      const signals = yield* signalRepository;
      const signal: Signal = {
        id,
        kind: "acme-tracker/mentioned",
        origin: { type: "event", eventId: 1, connectionId: CONNECTION, threadRef },
        title: "Marta mentioned you",
        priority: "normal",
        blocks: [],
        actions: [],
        match: {},
        status,
        ...(status === "resolved"
          ? {
              resolution: {
                kind: "decided" as const,
                actionId: "done",
                outcome: "Marked done",
                actor: "user" as const,
                origin: "web",
                at: AT,
              },
            }
          : {}),
        createdAt: AT,
      };
      yield* inTransaction(signals.insert(signal, []));
    });

  const SIGNAL_A = "0199e0e7-0005-7000-8000-000000000001";
  const SIGNAL_B = "0199e0e7-0005-7000-8000-000000000002";
  const SIGNAL_DONE = "0199e0e7-0005-7000-8000-000000000003";
  const SIGNAL_ELSEWHERE = "0199e0e7-0005-7000-8000-000000000004";

  const signalPushes = (announced: ReadonlyArray<unknown>) =>
    announced
      .filter((change) => (change as { topic?: string }).topic === "signal")
      .map((change) => (change as { id: string }).id)
      .sort();

  it("announces the open signals of a ref when a poll creates its full record, and nothing when the poll repeats", async () => {
    const result = await run(({ ingest, announced }) =>
      Effect.gen(function* () {
        yield* raiseSignal(SIGNAL_A, ticketRef("a"));
        yield* raiseSignal(SIGNAL_B, ticketRef("a"));
        yield* raiseSignal(SIGNAL_DONE, ticketRef("a"), "resolved");
        yield* raiseSignal(SIGNAL_ELSEWHERE, ticketRef("other"));
        yield* ingest.reconcile(reporter, complete([ticket("a")]));
        const first = signalPushes(announced);
        yield* ingest.reconcile(reporter, complete([ticket("a")]));
        yield* ingest.reconcile(reporter, complete([ticket("a", { title: "Renamed" })]));
        return { first, afterRepeat: signalPushes(announced) };
      }),
    );
    expect(result.first).toEqual([SIGNAL_A, SIGNAL_B]);
    expect(result.afterRepeat).toEqual([SIGNAL_A, SIGNAL_B]);
  });

  it("announces them when a partial record becomes full", async () => {
    const result = await run(({ ingest, announced }) =>
      Effect.gen(function* () {
        yield* raiseSignal(SIGNAL_A, ticketRef("a"));
        yield* ingest.refresh(reporter, [
          { kind: "ticket", ref: ticketRef("a"), title: "Ticket a", partial: true },
        ]);
        const whilePartial = signalPushes(announced);
        yield* ingest.refresh(reporter, [ticket("a")]);
        return { whilePartial, whenFull: signalPushes(announced) };
      }),
    );
    expect(result.whilePartial).toEqual([]);
    expect(result.whenFull).toEqual([SIGNAL_A]);
  });
});

describe("recognizing the addresses and texts of a call", () => {
  const AS_REF: EntityRecognition = {
    recognized: "ref",
    form: "url",
    ref: "acme-forge:change:7",
    kind: "acme-forge/change",
  };

  /** Builds a recognizer over one fake plugin, and records every text it was asked about. */
  const buildRecognizer = (answer: (text: string) => ReadonlyArray<EntityRecognition>) => {
    const asked: Array<string> = [];
    const recognize: RecognizeText = (text) => {
      asked.push(text);
      return Effect.succeed(
        answer(text).map((recognition) => ({ pluginId: "acme-forge", recognition })),
      );
    };
    return { asked, recognize };
  };

  const withRelations = (linkedUrls: ReadonlyArray<string>) => ({
    relations: { complete: true, partOf: [], linked: [], linkedUrls },
  });

  const readClaimTargets = (sql: SqlClient.SqlClient) =>
    Effect.map(
      sql<{ readonly to_ref: string; readonly evidence_key: string; readonly claim_type: string }>`
        SELECT to_ref, evidence_key, claim_type FROM external_entity_relation_claims ORDER BY id`,
      (rows) => rows.map((row) => [row.claim_type, row.evidence_key, row.to_ref]),
    );

  it("gives an address the first recognition of form url, and a pending target when nobody knows it", async () => {
    const claims = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        const { recognize } = buildRecognizer((text) =>
          text.includes("forge") ? [{ ...AS_REF, form: "identifier" }, AS_REF] : [],
        );
        yield* ingest.reconcile(
          reporter,
          complete([
            ticket("a", withRelations(["https://forge.example/7", "https://nobody.example/x"])),
          ]),
          recognize,
        );
        return yield* readClaimTargets(sql);
      }),
    );

    expect(claims).toEqual([
      ["source", "https://forge.example/7", "acme-forge:change:7"],
      ["source", "https://nobody.example/x", "unresolved:url:https://nobody.example/x"],
    ]);
  });

  it("recognizes nothing in a call that breaks a bound, and refuses it whole", async () => {
    const result = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        const { asked, recognize } = buildRecognizer(() => [AS_REF]);
        const fourTexts = [1, 2, 3, 4].map((n) => ({ evidenceKey: `k${n}`, text: "x" }));
        const tooLong = [{ evidenceKey: "k", text: "x".repeat(MAX_ENTITY_TEXT_LENGTH + 1) }];
        const messages: Array<string> = [];
        for (const overrides of [
          { texts: fourTexts },
          { texts: tooLong },
          withRelations(["javascript:1"]),
        ]) {
          const error = yield* Effect.flip(
            ingest.reconcile(
              reporter,
              complete([ticket("ok"), ticket("bad", overrides)]),
              recognize,
            ),
          );
          messages.push(error._tag);
        }
        return { asked, messages, written: yield* countWrittenRows(sql) };
      }),
    );

    expect(result.messages).toEqual(["PluginError", "PluginError", "PluginError"]);
    expect(result.asked).toEqual([]);
    expect(result.written).toEqual(NOTHING_WRITTEN);
  });

  it("searches a text that several observations carry once, and drops a ref that is not one", async () => {
    const result = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        const { asked, recognize } = buildRecognizer((text) =>
          text === "same"
            ? [AS_REF, { ...AS_REF, ref: "unresolved:sneaky" }, { ...AS_REF, ref: "has space" }]
            : [],
        );
        yield* ingest.reconcile(
          reporter,
          complete(
            ["a", "b"].map((name) =>
              ticket(name, { texts: [{ evidenceKey: "description", text: "same" }] }),
            ),
          ),
          recognize,
        );
        return { asked, claims: yield* readClaimTargets(sql) };
      }),
    );

    expect(result.asked).toEqual(["same"]);
    expect(result.claims).toEqual([
      ["text", "description", "acme-forge:change:7"],
      ["text", "description", "acme-forge:change:7"],
    ]);
  });

  it("keeps at most the most things one text may name", async () => {
    const claims = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        const many: Array<EntityRecognition> = Array.from({ length: 25 }, (_, n) => ({
          recognized: "scoped",
          form: "identifier",
          identifier: `OPS-${n}`,
        }));
        const { recognize } = buildRecognizer(() => many);
        yield* ingest.reconcile(
          reporter,
          complete([ticket("a", { texts: [{ evidenceKey: "description", text: "x" }] })]),
          recognize,
        );
        return yield* readClaimTargets(sql);
      }),
    );

    expect(claims).toHaveLength(20);
  });

  it("does not search a text whose revision equals the one its stored claims were made from", async () => {
    const result = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        const first = buildRecognizer(() => [AS_REF]);
        const texts = (notes: string) => [
          { evidenceKey: "description", text: "unchanged", revision: "r1" },
          { evidenceKey: "notes", text: notes, revision: notes },
        ];
        yield* ingest.reconcile(
          reporter,
          complete([ticket("a", { texts: texts("n1") })]),
          first.recognize,
        );
        // The plugin that found the claims is gone, and only the notes changed.
        const second = buildRecognizer(() => []);
        yield* ingest.reconcile(
          reporter,
          complete([ticket("a", { texts: texts("n2") })]),
          second.recognize,
        );
        return {
          firstAsked: first.asked,
          secondAsked: second.asked,
          claims: yield* readClaimTargets(sql),
        };
      }),
    );

    expect(result.firstAsked).toEqual(["unchanged", "n1"]);
    expect(result.secondAsked).toEqual(["n2"]);
    // The description keeps its claim although nothing recognizes it now. The notes lost theirs.
    expect(result.claims).toEqual([["text", "description", "acme-forge:change:7"]]);
  });

  it("writes nothing when the Connection stops ingesting while the texts are recognized", async () => {
    const result = await run(({ ingest, sql }) =>
      Effect.gen(function* () {
        const recognize: RecognizeText = () =>
          Effect.orDie(
            Effect.as(
              inTransaction(
                sql`UPDATE connections SET status = 'disabled' WHERE id = ${uuidFromString(CONNECTION)}`,
              ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              [{ pluginId: "acme-forge", recognition: AS_REF }],
            ),
          );
        const exit = yield* Effect.exit(
          ingest.reconcile(
            reporter,
            complete([ticket("a", { texts: [{ evidenceKey: "description", text: "x" }] })]),
            recognize,
          ),
        );
        return { exit, written: yield* countWrittenRows(sql) };
      }),
    );

    expect(Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toBeInstanceOf(
      ConnectionNotIngesting,
    );
    expect(result.written).toEqual(NOTHING_WRITTEN);
  });
});
