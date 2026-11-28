/**
 * Tests the boot step that copies the plugins' status tables onto the stored
 * External Entities: a thing stored under an older status table takes the
 * newer one, without a new observation.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { EntityStatusDeclaration, QualifiedEntityKindDeclaration } from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import { inTransaction } from "../db/testing";
import { PluginHost } from "../plugins";
import { TaskTestLayer } from "../tasks/testing";
import { ExternalEntityIngest, ExternalEntityIngestLayer } from "./ingest";
import { refreshStoredStatuses } from "./refresh-statuses";

const PLUGIN = "acme-tracker";
const CONNECTION = "0190c000-0000-7000-8000-0000000000a1";
const REF = "acme-tracker:ticket:one";

/** A ticket kind whose one status is `merged`, as `status` declares it. */
const buildTicketKind = (status: EntityStatusDeclaration): QualifiedEntityKindDeclaration => ({
  word: "acme-tracker/ticket",
  noun: "Ticket",
  refPrefix: "acme-tracker:ticket:",
  pace: "fast",
  patience: 24,
  identifier: "{key}",
  person: null,
  owner: null,
  status: { merged: status },
  facts: [],
  reasons: {},
});

const OLD_KIND = buildTicketKind({ shape: "join", tone: "quiet", word: "Merged", stage: "landed" });

const NEW_KIND = buildTicketKind({
  shape: "join",
  tone: "quiet",
  word: "Merged",
  stage: "landed",
  icon: { paths: ["M0 0h16v16H0z"] },
  color: { light: "#8250df", dark: "#ab7df8" },
});

/** A plugin host that has loaded the tracker plugin with `kind` as its only entity kind. */
const buildHost = (kind: QualifiedEntityKindDeclaration) =>
  Layer.succeed(PluginHost)({
    loaded: () => Effect.succeed([{ id: PLUGIN }]),
    listEntityKinds: () => Effect.succeed([kind]),
  } as unknown as PluginHost["Service"]);

/** Stores one merged ticket observed under `OLD_KIND`, then runs `body`. */
const run = <A>(body: Effect.Effect<A, unknown, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ingest = yield* ExternalEntityIngest;
      const at = "2026-03-01T00:00:00.000Z";
      yield* inTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
            VALUES (${PLUGIN}, 1, '{}', ${at}, ${at})`;
          yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
              status, labels, config, created_at, updated_at)
            VALUES (${uuidFromString(CONNECTION)}, ${PLUGIN}, ${`${PLUGIN}/account`}, 'work', 'work',
              'work', 'connected', '[]', '{}', ${at}, ${at})`;
        }),
      );
      yield* ingest.reconcile(
        { connectionId: CONNECTION, pluginId: PLUGIN, kinds: [OLD_KIND] },
        {
          kind: "ticket",
          complete: true,
          observations: [
            {
              kind: "ticket",
              ref: REF,
              title: "Ticket one",
              url: "https://tracker.example/one",
              lifecycle: "completed",
              status: "merged",
              fields: { key: "ONE" },
              concerns: ["assigned"],
              sourceUpdatedAt: "2026-03-01T10:00:00Z",
            },
          ],
        },
      );
      return yield* body;
    }).pipe(
      Effect.provide(ExternalEntityIngestLayer.pipe(Layer.provideMerge(TaskTestLayer))),
      Effect.orDie,
    ),
  );

const readStoredEntity = Effect.flatMap(SqlClient.SqlClient, (sql) =>
  Effect.map(
    sql<{ readonly status: string; readonly updated_at: string }>`
      SELECT status, updated_at FROM external_entities WHERE ref = ${REF}`,
    (rows) => ({ status: JSON.parse(rows[0]!.status) as unknown, updatedAt: rows[0]!.updated_at }),
  ),
);

describe("refreshStoredStatuses", () => {
  it("copies a newer status table onto a stored thing, and leaves its update time alone", async () => {
    const { before, changed, after } = await run(
      Effect.gen(function* () {
        const before = yield* readStoredEntity;
        const changed = yield* Effect.provide(refreshStoredStatuses, buildHost(NEW_KIND));
        return { before, changed, after: yield* readStoredEntity };
      }),
    );

    expect(changed).toBe(1);
    expect(after.status).toEqual({
      shape: "join",
      tone: "quiet",
      label: "Merged",
      icon: { paths: ["M0 0h16v16H0z"] },
      color: { light: "#8250df", dark: "#ab7df8" },
      stage: "landed",
    });
    expect(after.updatedAt).toBe(before.updatedAt);
  });

  it("changes nothing when the stored status already matches the table", async () => {
    const changed = await run(Effect.provide(refreshStoredStatuses, buildHost(OLD_KIND)));

    expect(changed).toBe(0);
  });
});
