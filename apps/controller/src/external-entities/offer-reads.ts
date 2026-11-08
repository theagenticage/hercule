/**
 * The reads behind a card's offers: the Connections that can act on each
 * thing, the workflows a run can start and the repositories of their
 * workspaces. The rules that turn them into offers are in `offers.ts`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  MAX_ACTING_CONNECTIONS,
  type ActingConnection,
  type WorkflowOffer,
} from "@hercule/contract";
import { uuidFromString, uuidToString } from "../db";
import { isCheckedOut, resourceRepository } from "../resources";
import { workflowRepository } from "../workflows";
import {
  buildOfferSetId,
  evaluateOffer,
  evaluateOffers,
  listWorkspaceResourceIds,
  type OfferedKind,
  type OfferSubject,
} from "./offers";

/** A thing to read the offers of: its ref, its qualified kind and the repository its work lands in, if it has one. */
export interface OfferTarget {
  readonly ref: string;
  readonly kind: string;
  readonly targetRemote: string | undefined;
}

/** What `readOffers` returns. */
export interface OffersRead {
  /** The id of the offer set of each target, by ref. */
  readonly offerSetIds: ReadonlyMap<string, string>;
  /** The offers of each distinct set, by offer set id. */
  readonly offerSets: Readonly<Record<string, ReadonlyArray<WorkflowOffer>>>;
  /**
   * The Connections that can act on each target, by ref, oldest first and
   * cut to `MAX_ACTING_CONNECTIONS`. A ref none can act on is absent.
   */
  readonly actingConnections: ReadonlyMap<string, ReadonlyArray<ActingConnection>>;
}

/** Builds the offer reads. They need the database and the repositories of workflows and Resources. */
export const makeOfferReads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workflows = yield* workflowRepository;
  const resources = yield* resourceRepository;

  /**
   * Builds the `FROM ... WHERE` of the one rule for a Connection acting on a
   * thing. A Connection acts on a thing when it is of the Connection type of
   * the thing's plugin, its last read of the thing had `access: ok`, and its
   * status is not `disabled`: the same status rule a run start applies to a
   * `connection` input. `pairs` give each ref the type that counts for it.
   * Every read below uses this fragment, so the menu and the handoff cannot
   * disagree. It exposes the aliases `o` (observation) and `c` (Connection).
   */
  const buildActingFilter = (
    pairs: ReadonlyArray<{ readonly ref: string; readonly type: string }>,
  ) => sql`
    FROM external_entity_observations o
    JOIN connections c ON c.id = o.connection_id
    JOIN json_each(${JSON.stringify(pairs)}) AS target
      ON json_extract(target.value, '$.ref') = o.ref AND json_extract(target.value, '$.type') = c.type
    WHERE o.access = 'ok' AND c.status <> 'disabled'`;

  /**
   * Returns the (ref, Connection type) pairs of the targets whose kind is
   * offered. A target whose plugin is not running has no pair, so nothing
   * acts on it.
   */
  const buildPairs = (
    targets: ReadonlyArray<OfferTarget>,
    kinds: ReadonlyMap<string, OfferedKind>,
  ) =>
    targets.flatMap((target) => {
      const type = kinds.get(target.kind)?.connectionType;
      return type === undefined ? [] : [{ ref: target.ref, type }];
    });

  /**
   * Returns the Connections that can act on each target, oldest first by
   * `(created_at, id)`, at most `MAX_ACTING_CONNECTIONS` for each target, in
   * one statement however many targets there are.
   */
  const listActingConnections = (
    pairs: ReadonlyArray<{ readonly ref: string; readonly type: string }>,
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ActingConnection>>, SqlError> =>
    pairs.length === 0
      ? Effect.succeed(new Map())
      : Effect.map(
          sql<{ readonly ref: string; readonly id: Uint8Array; readonly label: string }>`
            SELECT ref, id, label FROM (
              SELECT o.ref AS ref, c.id AS id, c.label AS label,
                ROW_NUMBER() OVER (PARTITION BY o.ref ORDER BY c.created_at, c.id) AS position
              ${buildActingFilter(pairs)})
            WHERE position <= ${MAX_ACTING_CONNECTIONS}
            ORDER BY ref, position`,
          (rows) => {
            const acting = new Map<string, Array<ActingConnection>>();
            for (const row of rows) {
              const connection = { id: uuidToString(row.id), label: row.label };
              const found = acting.get(row.ref);
              if (found === undefined) acting.set(row.ref, [connection]);
              else found.push(connection);
            }
            return acting;
          },
        );

  /**
   * Returns the canonical remote of each repo that one of `ids` names, by
   * Resource id, in one statement.
   */
  const readWorkspaceRemotes = (
    ids: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
    Effect.map(
      resources.byIds([...new Set(ids)]),
      (found) =>
        new Map(
          [...found.values()].flatMap((resource) =>
            isCheckedOut(resource) ? [[resource.id, resource.canonicalRemote] as const] : [],
          ),
        ),
    );

  /** Builds the subject of a target: an unknown kind (its plugin is not running) has no Connection type. */
  const buildSubject = (
    target: OfferTarget,
    kinds: ReadonlyMap<string, OfferedKind>,
    hasAccount: boolean,
  ): OfferSubject => ({
    kind: kinds.get(target.kind) ?? { kind: target.kind, connectionType: "", signalKinds: [] },
    targetRemote: target.targetRemote,
    hasAccount,
  });

  const indexKinds = (offeredKinds: ReadonlyArray<OfferedKind>) =>
    new Map(offeredKinds.map((offered) => [offered.kind, offered]));

  return {
    /**
     * Returns the offers and the acting Connections of `targets`, for a menu.
     * Targets with the same kind, target repository and acting-account state
     * share one offer set, evaluated once. A target whose kind is not in
     * `offeredKinds` (its plugin is not running) has no acting Connection.
     *
     * The lists are cut so a read can never exceed the contract's bounds:
     * offers to `MAX_ENTITY_OFFERS` (available first, each group by name),
     * Connections to `MAX_ACTING_CONNECTIONS` (oldest first). Nothing that
     * decides a handoff may read these lists; use `readOfferOfWorkflow` and
     * `findActingConnection`, which are not cut.
     *
     * A constant number of statements however many targets there are: the
     * acting Connections, the runnable workflows and the Resources they name.
     */
    readOffers: (
      targets: ReadonlyArray<OfferTarget>,
      offeredKinds: ReadonlyArray<OfferedKind>,
    ): Effect.Effect<OffersRead, SqlError> =>
      Effect.gen(function* () {
        if (targets.length === 0) {
          return { offerSetIds: new Map(), offerSets: {}, actingConnections: new Map() };
        }
        const kinds = indexKinds(offeredKinds);
        const actingConnections = yield* listActingConnections(buildPairs(targets, kinds));
        const runnable = yield* workflows.listRunnableDefinitions();
        const remotes = yield* readWorkspaceRemotes(
          runnable.flatMap(({ definition }) => listWorkspaceResourceIds(definition)),
        );

        const offerSetIds = new Map<string, string>();
        const offerSets: Record<string, ReadonlyArray<WorkflowOffer>> = {};
        for (const target of targets) {
          const subject = buildSubject(target, kinds, actingConnections.has(target.ref));
          const id = buildOfferSetId(subject);
          offerSetIds.set(target.ref, id);
          offerSets[id] ??= evaluateOffers(runnable, subject, remotes);
        }
        return { offerSetIds, offerSets, actingConnections };
      }),

    /**
     * Returns the offer of one workflow for one target, evaluated by the same
     * rules as the menu (`evaluateOffer`) but from the whole state: no cut
     * applies. Returns none when the workflow is not enabled and valid, or is
     * not listed for the target's kind. An offer with `unavailable` set is
     * returned as it is; the caller refuses it.
     */
    readOfferOfWorkflow: (
      target: OfferTarget,
      workflowId: string,
      offeredKinds: ReadonlyArray<OfferedKind>,
    ): Effect.Effect<Option.Option<WorkflowOffer>, SqlError> =>
      Effect.gen(function* () {
        const found = (yield* workflows.listRunnableDefinitions()).find(
          (candidate) => candidate.id === workflowId,
        );
        if (found === undefined) return Option.none();
        const kinds = indexKinds(offeredKinds);
        const pairs = buildPairs([target], kinds);
        const acting =
          pairs.length === 0
            ? []
            : yield* sql<{ readonly one: number }>`
                SELECT 1 AS one ${buildActingFilter(pairs)} LIMIT 1`;
        const remotes = yield* readWorkspaceRemotes(listWorkspaceResourceIds(found.definition));
        return Option.fromNullishOr(
          evaluateOffer(found, buildSubject(target, kinds, acting.length > 0), remotes),
        );
      }),

    /**
     * Returns the Connection that acts for a handoff on `target`, or none.
     * With `connectionId`, that Connection when it can act on the target.
     * Without, the oldest one that can. Not cut by any bound.
     */
    findActingConnection: (
      target: OfferTarget,
      connectionId: string | undefined,
      offeredKinds: ReadonlyArray<OfferedKind>,
    ): Effect.Effect<Option.Option<ActingConnection>, SqlError> =>
      Effect.gen(function* () {
        const pairs = buildPairs([target], indexKinds(offeredKinds));
        if (pairs.length === 0) return Option.none();
        const rows = yield* sql<{ readonly id: Uint8Array; readonly label: string }>`
          SELECT c.id AS id, c.label AS label ${buildActingFilter(pairs)}
          ${connectionId === undefined ? sql`` : sql`AND c.id = ${uuidFromString(connectionId)}`}
          ORDER BY c.created_at, c.id LIMIT 1`;
        return Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          id: uuidToString(row.id),
          label: row.label,
        }));
      }),
  };
});
