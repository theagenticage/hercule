/**
 * The working areas the fleet holds: the two operations a user asks for by
 * name, provision and dispose, what a machine that has just dialled in is still
 * owed, and the sweep that takes away what nothing needs any more.
 *
 * Every row is written and committed before its machine is told, because a
 * transaction never spans a wait on a machine. The sweep decides and the
 * machine deletes: one that is not connected keeps its disk and is left for the
 * next pass rather than having it changed behind its back.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  Id,
  validationOf,
  WorkspaceProvisionInput,
  type Conflict,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Unauthenticated,
  type Validation,
  type Workspace,
} from "@hercule/contract";
import { requireGrant, SYSTEM_ACTOR, USER_ACTOR } from "../actor";
import { withTransaction } from "../db";
import { RunnerConnections } from "../runners";
import { WorkspaceService } from "../workspaces";
import { absorbing, forking } from "./absorbing";

const Identified = Schema.Struct({ id: Id });

type Identified = Schema.Schema.Type<typeof Identified>;

const decodeProvision = Schema.decodeUnknownEffect(WorkspaceProvisionInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

type WorkspaceError = Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError;

/** How often the controller looks for workspaces nothing needs any more. */
const WORKSPACE_SWEEP_INTERVAL: Duration.Duration = Duration.minutes(10);

/** Tests hand over an interval they can wait out. */
export const WorkspaceSweepInterval = Context.Reference<Duration.Duration>(
  "hydra/controller/daemon/WorkspaceSweepInterval",
  { defaultValue: (): Duration.Duration => WORKSPACE_SWEEP_INTERVAL },
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;

  /** One pass of the expiry sweep. */
  const sweep = Effect.gen(function* () {
    for (const candidate of yield* workspaces.expiredCandidates()) {
      // The check and the write are one transaction: a session starting in a
      // workspace between the two would otherwise have its directory swept out
      // from under it.
      const gone = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const row = yield* workspaces.sweepable(candidate.id);
          if (row === undefined) return undefined;
          const frame = yield* workspaces.markGone(row, SYSTEM_ACTOR, candidate.reason);
          return { runnerId: row.runnerId, frame };
        }),
      );
      if (gone === undefined) continue;
      yield* connections.tell(gone.runnerId, gone.frame);
    }
  });

  const resendProvisioning = (runnerId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      for (const frame of yield* workspaces.owedProvisioning(runnerId)) {
        yield* connections.tell(runnerId, frame);
      }
    });

  return {
    /**
     * The repo's own workspace on one machine, cloned fresh under that
     * machine's own storage.
     */
    provisionWorkspace: (
      input: WorkspaceProvisionInput,
    ): Effect.Effect<Workspace, WorkspaceError | Conflict> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.provision");
        const decoded = yield* Effect.mapError(decodeProvision(input), validationOf);
        const { workspace, frame } = yield* withTransaction(
          sql,
          workspaces.openPrimaryFor({
            resourceId: decoded.resourceId,
            runnerId: decoded.runnerId,
          }),
        );
        // After the commit. A machine that is not listening is told again when
        // it dials in, from the rows this just wrote.
        yield* connections.tell(decoded.runnerId, frame);
        return workspace;
      }),

    /** Takes a workspace away: the row says so, then the machine is told. */
    disposeWorkspace: (input: Identified): Effect.Effect<Record<string, never>, WorkspaceError> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.dispose");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        // The refusal and the write are one transaction, so a session that
        // starts in the workspace while this runs is either refused or is not
        // there yet.
        const { runnerId, frame } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const workspace = yield* workspaces.disposable(id);
            return {
              runnerId: workspace.runnerId,
              frame: yield* workspaces.markGone(workspace, USER_ACTOR),
            };
          }),
        );
        // After the commit: a transaction never spans a wait on a machine.
        yield* connections.tell(runnerId, frame);
        return {};
      }),

    /**
     * What the controller does about workspaces on its own: it tells a machine
     * that has just dialled in what it still owes, and it sweeps what nothing
     * needs any more.
     */
    driving: Effect.all(
      [
        Stream.runForEach(connections.arrivals, (runnerId) =>
          forking("A machine could not be told what it still owes", resendProvisioning(runnerId)),
        ),
        Effect.gen(function* () {
          const interval = yield* WorkspaceSweepInterval;
          while (true) {
            yield* Effect.sleep(interval);
            yield* absorbing("The workspace expiry sweep failed", sweep);
          }
        }),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  };
});

export class Provisioning extends Context.Service<Provisioning, Effect.Success<typeof make>>()(
  "hydra/controller/daemon/Provisioning",
) {}

export const ProvisioningLayer: Layer.Layer<
  Provisioning,
  never,
  SqlClient.SqlClient | WorkspaceService | RunnerConnections
> = Layer.effect(Provisioning)(make);
