/**
 * Workspaces on the fleet:
 *
 * - the two workspace operations a user calls, provision and dispose;
 * - resending pending provisioning to a runner that has just connected;
 * - the sweep that removes workspaces nothing needs any more.
 *
 * Every row is committed before its runner is told, because a transaction
 * never waits on a runner. The sweep decides and the runner deletes the
 * files. The sweep skips a runner that is not connected, so its files are not
 * changed behind its back; a later pass handles them.
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
  createDecodeValidationError,
  Id,
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
import { absorbFailures, forkAndAbsorbFailures } from "./absorbing";

const Identified = Schema.Struct({ id: Id });

type Identified = Schema.Schema.Type<typeof Identified>;

const decodeProvision = Schema.decodeUnknownEffect(WorkspaceProvisionInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

type WorkspaceError = Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError;

/** How often the controller looks for workspaces nothing needs any more. */
const WORKSPACE_SWEEP_INTERVAL: Duration.Duration = Duration.minutes(10);

/** The sweep interval. Tests override it with a shorter one. */
export const WorkspaceSweepInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/WorkspaceSweepInterval",
  { defaultValue: (): Duration.Duration => WORKSPACE_SWEEP_INTERVAL },
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;

  /** One pass of the expiry sweep. */
  const sweep = Effect.gen(function* () {
    for (const candidate of yield* workspaces.expiredCandidates()) {
      // The check and the write are one transaction. Otherwise a session that
      // starts in the workspace between the two would have its directory
      // deleted while it runs.
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
     * Provisions the main workspace of a repo resource on one runner: a fresh
     * clone under the runner's own storage. Returns the workspace row, before
     * the runner has finished the clone.
     */
    provisionWorkspace: (
      input: WorkspaceProvisionInput,
    ): Effect.Effect<Workspace, WorkspaceError | Conflict> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.provision");
        const decoded = yield* Effect.mapError(decodeProvision(input), createDecodeValidationError);
        const { workspace, frame } = yield* withTransaction(
          sql,
          workspaces.openPrimaryFor({
            resourceId: decoded.resourceId,
            runnerId: decoded.runnerId,
          }),
        );
        // After the commit. A runner that is not connected receives the frame
        // when it connects, rebuilt from the rows just written.
        yield* connections.tell(decoded.runnerId, frame);
        return workspace;
      }),

    /** Disposes of a workspace: marks the row gone, then tells the runner to delete it. */
    disposeWorkspace: (input: Identified): Effect.Effect<Record<string, never>, WorkspaceError> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.dispose");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        // The check and the write are one transaction, so a session that starts
        // in the workspace at the same time is either rejected or starts after
        // the dispose.
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
        // After the commit: a transaction never waits on a runner.
        yield* connections.tell(runnerId, frame);
        return {};
      }),

    /**
     * Runs forever. Resends pending provisioning frames to each runner that
     * connects, and sweeps expired workspaces on an interval.
     */
    driving: Effect.all(
      [
        Stream.runForEach(connections.arrivals, (runnerId) =>
          forkAndAbsorbFailures(
            "Resending pending provisioning to a runner failed",
            resendProvisioning(runnerId),
          ),
        ),
        Effect.gen(function* () {
          const interval = yield* WorkspaceSweepInterval;
          while (true) {
            yield* Effect.sleep(interval);
            yield* absorbFailures("Sweeping expired workspaces failed", sweep);
          }
        }),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  };
});

export class Provisioning extends Context.Service<Provisioning, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Provisioning",
) {}

export const ProvisioningLayer: Layer.Layer<
  Provisioning,
  never,
  SqlClient.SqlClient | WorkspaceService | RunnerConnections
> = Layer.effect(Provisioning)(make);
