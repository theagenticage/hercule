/**
 * The reads behind a card's offers and a handoff: the Connections that can
 * act on each thing, the workflows a run can start and the repositories of
 * their workspaces. The rules that turn them into offers are in
 * `workflow-offers.ts`.
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
  buildWorkflowOfferSetId,
  evaluateWorkflowOffer,
  evaluateWorkflowOffers,
  listWorkspaceResourceIds,
  type EntityKindSource,
  type WorkflowOfferSubject,
} from "./workflow-offers";

/** The refusal of a handoff to a workflow that is not enabled, not valid, or not listed for the kind of thing. */
const WORKFLOW_NOT_LISTED = "That workflow cannot take this. Reload the Inbox and choose again.";

/** The refusal of a handoff by an account that cannot act on the thing. */
const CHOSEN_ACCOUNT_CANNOT_ACT = "That account cannot act on this. Choose another account.";

/** A thing to read the offers of: its ref, its qualified kind and the repository its work lands in, if it has one. */
export interface WorkflowOfferTarget {
  readonly ref: string;
  readonly kind: string;
  readonly targetRemote: string | undefined;
}

/**
 * What `prepareHandoff` returns: the offer the handoff accepts and the
 * Connection that acts, or the words that refuse it.
 */
export type HandoffPreparation =
  | {
      readonly _tag: "Accepted";
      readonly offer: WorkflowOffer;
      readonly connection: ActingConnection;
    }
  | { readonly _tag: "Refused"; readonly words: string };

/** What `readWorkflowOffers` returns. */
export interface WorkflowOffersRead {
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
export const makeWorkflowOfferReads = Effect.gen(function* () {
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
   *
   * The status condition is written in SQL here and in TypeScript in the run
   * start (`listDisabledConnectionIssues` in runs/start.ts). Change one and
   * you must change the other.
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
    targets: ReadonlyArray<WorkflowOfferTarget>,
    kinds: ReadonlyMap<string, EntityKindSource>,
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
    target: WorkflowOfferTarget,
    source: EntityKindSource | undefined,
    hasAccount: boolean,
  ): WorkflowOfferSubject => ({
    kind: source ?? { kind: target.kind, connectionType: "", signalKinds: [] },
    targetRemote: target.targetRemote,
    hasAccount,
  });

  /**
   * Returns when the user last handed a thing of each kind to each workflow,
   * from the hand-off history: a Task's provenance entries that name both a
   * thing and the run the hand-off started. The key is `<workflow id>|<kind>`.
   * One statement, none for no kinds.
   */
  const readLastHandedTimes = (
    kinds: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, string>, SqlError> =>
    kinds.length === 0
      ? Effect.succeed(new Map())
      : Effect.map(
          sql<{
            readonly workflow_id: Uint8Array;
            readonly kind: string;
            readonly last_at: string;
          }>`
            SELECT r.workflow_id AS workflow_id, e.kind AS kind, MAX(p.at) AS last_at
            FROM task_provenance p
              JOIN runs r ON r.id = p.run_id
              JOIN external_entities e ON e.ref = p.ref
            WHERE p.run_id IS NOT NULL AND p.ref IS NOT NULL AND r.workflow_id IS NOT NULL
              AND e.kind IN (SELECT value FROM json_each(${JSON.stringify(kinds)}))
            GROUP BY r.workflow_id, e.kind`,
          (rows) =>
            new Map(
              rows.map((row) => [`${uuidToString(row.workflow_id)}|${row.kind}`, row.last_at]),
            ),
        );

  const indexKinds = (kindSources: ReadonlyArray<EntityKindSource>) =>
    new Map(kindSources.map((offered) => [offered.kind, offered]));

  return {
    /**
     * Returns the offers and the acting Connections of `targets`, for a menu.
     * Targets with the same kind, target repository and acting-account state
     * share one offer set, evaluated once. A target whose kind is not in
     * `kindSources` (its plugin is not running) has no acting Connection.
     *
     * The lists are cut so a read can never exceed the contract's bounds:
     * offers to `MAX_ENTITY_OFFERS` (available first, each group by name),
     * Connections to `MAX_ACTING_CONNECTIONS` (oldest first). Nothing that
     * decides a handoff may read these lists; use `prepareHandoff`, which is
     * not cut. Each offer carries `lastHandedAt`, when the user last handed a
     * thing of its kind to its workflow.
     *
     * A constant number of statements however many targets there are: the
     * acting Connections, the workflows with an entity or signal input, the
     * Resources they name and the hand-off history.
     */
    readWorkflowOffers: (
      targets: ReadonlyArray<WorkflowOfferTarget>,
      kindSources: ReadonlyArray<EntityKindSource>,
    ): Effect.Effect<WorkflowOffersRead, SqlError> =>
      Effect.gen(function* () {
        if (targets.length === 0) {
          return { offerSetIds: new Map(), offerSets: {}, actingConnections: new Map() };
        }
        const kinds = indexKinds(kindSources);
        const actingConnections = yield* listActingConnections(buildPairs(targets, kinds));
        const candidates = yield* workflows.listWorkflowOfferCandidates();
        const remotes = yield* readWorkspaceRemotes(
          candidates.flatMap(({ workspace }) => listWorkspaceResourceIds(workspace)),
        );
        const handed = yield* readLastHandedTimes([
          ...new Set(targets.map((target) => target.kind)),
        ]);

        const offerSetIds = new Map<string, string>();
        const offerSets: Record<string, ReadonlyArray<WorkflowOffer>> = {};
        for (const target of targets) {
          const subject = buildSubject(
            target,
            kinds.get(target.kind),
            actingConnections.has(target.ref),
          );
          const id = buildWorkflowOfferSetId(subject);
          offerSetIds.set(target.ref, id);
          offerSets[id] ??= evaluateWorkflowOffers(candidates, subject, remotes).map((offer) => {
            const lastHandedAt = handed.get(`${offer.workflowId}|${target.kind}`);
            return lastHandedAt === undefined ? offer : { ...offer, lastHandedAt };
          });
        }
        return { offerSetIds, offerSets, actingConnections };
      }),

    /**
     * Decides whether one workflow can take one thing and which Connection
     * acts, for a handoff, and returns the accepted offer with that
     * Connection, or the words that refuse it. It reads the one workflow and
     * the accounts of the one thing, so no cut list decides a handoff, and it
     * evaluates the workflow with the same `evaluateWorkflowOffer` and the
     * same acting rule as the menu: what a menu offered and what a handoff
     * accepts cannot disagree.
     *
     * With `connectionId`, that Connection acts when it can; when it cannot,
     * the handoff is refused and no other account is put in its place.
     * Without one, the oldest Connection that can act does. `kindSource` is
     * what the thing's plugin declares for its kind, or none when the plugin
     * is not running.
     *
     * The words refuse: a workflow that is not enabled, not valid or not
     * listed for the kind; an offer that is unavailable (its own message); a
     * chosen account that cannot act.
     */
    prepareHandoff: (
      target: WorkflowOfferTarget,
      workflowId: string,
      connectionId: string | undefined,
      kindSource: EntityKindSource | undefined,
    ): Effect.Effect<HandoffPreparation, SqlError> =>
      Effect.gen(function* () {
        const found = Option.getOrUndefined(
          yield* workflows.readWorkflowOfferCandidate(workflowId),
        );
        if (found === undefined) return { _tag: "Refused", words: WORKFLOW_NOT_LISTED };
        const pairs =
          kindSource === undefined ? [] : [{ ref: target.ref, type: kindSource.connectionType }];
        // The chosen Connection sorts first, so it is the row returned when it
        // can act; else the oldest acting Connection is, and `chosen` is 0.
        const rows =
          pairs.length === 0
            ? []
            : yield* sql<{
                readonly id: Uint8Array;
                readonly label: string;
                readonly chosen: number;
              }>`
                SELECT c.id AS id, c.label AS label,
                  COALESCE(c.id = ${connectionId === undefined ? null : uuidFromString(connectionId)}, 0) AS chosen
                ${buildActingFilter(pairs)}
                ORDER BY chosen DESC, c.created_at, c.id LIMIT 1`;
        const row = rows[0];
        const remotes = yield* readWorkspaceRemotes(listWorkspaceResourceIds(found.workspace));
        const offer = evaluateWorkflowOffer(
          found,
          buildSubject(target, kindSource, row !== undefined),
          remotes,
        );
        if (offer === undefined) return { _tag: "Refused", words: WORKFLOW_NOT_LISTED };
        if (offer.unavailable !== undefined) {
          return { _tag: "Refused", words: offer.unavailable.message };
        }
        // An offer is available only when an account can act, so `row` exists.
        if (row === undefined || (connectionId !== undefined && row.chosen === 0)) {
          return { _tag: "Refused", words: CHOSEN_ACCOUNT_CANNOT_ACT };
        }
        return {
          _tag: "Accepted",
          offer,
          connection: { id: uuidToString(row.id), label: row.label },
        };
      }),
  };
});
