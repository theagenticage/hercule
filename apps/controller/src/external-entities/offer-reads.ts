/**
 * The reads behind a card's offers: the Connections that can act on each
 * thing, the workflows a run can start and the repositories of their
 * workspaces. The rules that turn them into offers are in `offers.ts`.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { ActingConnection, WorkflowOffer } from "@hercule/contract";
import { uuidToString } from "../db";
import { isCheckedOut, resourceRepository } from "../resources";
import { workflowRepository } from "../workflows";
import {
  buildOfferSetId,
  evaluateOffers,
  listWorkspaceResourceIds,
  type OfferedKind,
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
  /** The Connections that can act on each target, by ref, oldest first. A ref none can act on is absent. */
  readonly actingConnections: ReadonlyMap<string, ReadonlyArray<ActingConnection>>;
}

/** Builds the offer reads. They need the database and the repositories of workflows and Resources. */
export const makeOfferReads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workflows = yield* workflowRepository;
  const resources = yield* resourceRepository;

  /**
   * Returns the Connections that can act on each target, in one statement
   * however many targets there are. A Connection acts on a thing when it is
   * of the Connection type of the thing's plugin, its last read of the thing
   * had `access: ok`, and its status is not `disabled`: the same status rule
   * a run start applies to a `connection` input. Oldest first.
   */
  const listActingConnections = (
    targets: ReadonlyArray<OfferTarget>,
    connectionTypes: ReadonlyMap<string, string>,
  ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<ActingConnection>>, SqlError> =>
    targets.length === 0
      ? Effect.succeed(new Map())
      : Effect.map(
          sql<{
            readonly ref: string;
            readonly id: Uint8Array;
            readonly label: string;
            readonly type: string;
          }>`
            SELECT o.ref, c.id, c.label, c.type
            FROM external_entity_observations o
            JOIN connections c ON c.id = o.connection_id
            WHERE o.ref IN (SELECT value FROM json_each(${JSON.stringify(targets.map((target) => target.ref))}))
              AND o.access = 'ok' AND c.status <> 'disabled'
            ORDER BY c.created_at, c.id`,
          (rows) => {
            const acting = new Map<string, Array<ActingConnection>>();
            const typeOfRef = new Map(
              targets.map((target) => [target.ref, connectionTypes.get(target.kind)]),
            );
            for (const row of rows) {
              if (row.type !== typeOfRef.get(row.ref)) continue;
              const connection = { id: uuidToString(row.id), label: row.label };
              const found = acting.get(row.ref);
              if (found === undefined) acting.set(row.ref, [connection]);
              else found.push(connection);
            }
            return acting;
          },
        );

  /**
   * Returns the canonical remote of each repo that a runnable workflow's
   * workspace names, by Resource id, in one statement.
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

  return {
    /**
     * Returns the offers and the acting Connections of `targets`. Targets
     * with the same kind, target repository and acting-account state share
     * one offer set, evaluated once. A target whose kind is not in
     * `offeredKinds` (its plugin is not running) has no acting Connection.
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
        const kinds = new Map(offeredKinds.map((offered) => [offered.kind, offered]));
        const actingConnections = yield* listActingConnections(
          targets,
          new Map(offeredKinds.map((offered) => [offered.kind, offered.connectionType])),
        );
        const runnable = yield* workflows.listRunnableDefinitions();
        const remotes = yield* readWorkspaceRemotes(
          runnable.flatMap(({ definition }) => listWorkspaceResourceIds(definition)),
        );

        const offerSetIds = new Map<string, string>();
        const offerSets: Record<string, ReadonlyArray<WorkflowOffer>> = {};
        for (const target of targets) {
          const subject = {
            kind: kinds.get(target.kind) ?? {
              kind: target.kind,
              connectionType: "",
              signalKinds: [],
            },
            targetRemote: target.targetRemote,
            hasAccount: actingConnections.has(target.ref),
          };
          const id = buildOfferSetId(subject);
          offerSetIds.set(target.ref, id);
          offerSets[id] ??= evaluateOffers(runnable, subject, remotes);
        }
        return { offerSetIds, offerSets, actingConnections };
      }),
  };
});
