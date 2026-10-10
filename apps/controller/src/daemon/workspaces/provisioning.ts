/**
 * Workspaces on the fleet:
 *
 * - the two workspace operations a user calls, provision and dispose;
 * - the sweep that removes workspaces nothing needs any more.
 *
 * A runner that connects is sent the provisioning still owed to it by the
 * arrival in `runners/`, together with the rest of the work owed to it.
 *
 * Every row is committed before its runner is told, because a transaction
 * never waits on a runner. The sweep decides and the runner deletes the
 * files. The sweep skips a runner that is not connected, so its files are not
 * changed behind its back; a later pass handles them.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createForbiddenError,
  WorkspaceAttachInput,
  WorkspaceDisposeInput,
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
import { CurrentActor, currentStamp, requireGrant, SYSTEM_ACTOR } from "../../actor";
import { withTransaction, mintUuid, uuidToString } from "../../db";
import { PromotionState } from "../../promotion";
import { RunnerConnections } from "../../runners";
import { WorkspaceService } from "../../workspaces";
import { absorbFailures } from "../absorbing";

const decodeDispose = Schema.decodeUnknownEffect(WorkspaceDisposeInput);

const decodeAttach = Schema.decodeUnknownEffect(WorkspaceAttachInput);

const decodeProvision = Schema.decodeUnknownEffect(WorkspaceProvisionInput);

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
  const promotion = yield* PromotionState;

  /** One pass of the expiry sweep. */
  const sweep = Effect.gen(function* () {
    for (const id of yield* workspaces.listSweepCandidates()) {
      // The check and the write are one transaction. Otherwise a session that is
      // resumed in the workspace between the two would have its directory
      // deleted while it runs.
      const gone = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* workspaces.sweepable(id);
          if (found === undefined) return undefined;
          const frame = yield* workspaces.reserveDisposal(found.workspace, SYSTEM_ACTOR, {
            expired: found.expired,
          });
          return { runnerId: found.workspace.runnerId, frame };
        }),
      );
      if (gone === undefined) continue;
      yield* connections.tell(gone.runnerId, gone.frame);
    }
  });

  return {
    /** Refreshes current Git facts through the runner, without fetching or rerunning setup. */
    inspectWorkspace: (id: Id): Effect.Effect<Workspace, Exclude<WorkspaceError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.inspect");
        const stored = yield* workspaces.readStoredWorkspace(id);
        if (!(yield* workspaces.supportsInspection(stored.runnerId)))
          return yield* Effect.fail(
            createInvalidStateError(
              "This runner does not support workspace inspection. Upgrade and reconnect it before inspecting the workspace.",
            ),
          );
        const answer = yield* connections.asked(
          stored.runnerId,
          {
            _tag: "workspaceInspect",
            requestId: uuidToString(mintUuid()),
            workspaceId: id,
          },
          Duration.seconds(10),
        );
        if (
          Option.isNone(answer) ||
          answer.value._tag !== "workspaceInspection" ||
          answer.value.report.workspaceId !== id ||
          answer.value.report.observedAt === undefined
        )
          return yield* Effect.fail(
            createInvalidStateError(
              "The runner is offline or unavailable and did not return a current workspace observation. Reconnect it and inspect again.",
            ),
          );
        yield* withTransaction(
          sql,
          workspaces.recordObservation(stored.runnerId, answer.value.report, yield* currentStamp),
        );
        return yield* workspaces.read(id);
      }),

    /** Persists a user-authorized attachment before asking its runner to validate the checkout. */
    attachWorkspace: (
      input: WorkspaceAttachInput,
    ): Effect.Effect<Workspace, WorkspaceError | Conflict> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.attach");
        if ((yield* CurrentActor)._tag !== "user") {
          return yield* Effect.fail(
            createForbiddenError(
              "workspace.write",
              "Only the user may attach an existing checkout. No session or workflow grant authorizes an external path.",
            ),
          );
        }
        const decoded = yield* Effect.mapError(decodeAttach(input), createDecodeValidationError);
        const { workspace, frame } = yield* withTransaction(
          sql,
          workspaces.openAttachmentFor(decoded),
        );
        yield* connections.tell(decoded.runnerId, frame);
        return workspace;
      }),

    /**
     * Provisions the main workspace of a repo resource on one runner: a fresh
     * worktree under the runner's own storage. Returns the workspace row before
     * preparation finishes.
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

    /** Reserves safe removal before asking the runner to remove managed files. */
    disposeWorkspace: (
      id: Id,
      input: WorkspaceDisposeInput = {},
    ): Effect.Effect<Record<string, never>, WorkspaceError> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.dispose");
        if (input?.discardChanges === true && (yield* CurrentActor)._tag !== "user")
          return yield* Effect.fail(
            createForbiddenError(
              "workspace.write",
              "Only the user may discard workspace changes. Sessions and workflows may request ordinary safe disposal.",
            ),
          );
        const decoded = yield* Effect.mapError(
          decodeDispose(input ?? {}),
          createDecodeValidationError,
        );
        const actor = yield* currentStamp;
        const { runnerId, frame } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const workspace = yield* workspaces.disposable(id);
            return {
              runnerId: workspace.runnerId,
              frame: yield* workspaces.reserveDisposal(workspace, actor, {
                discardChanges: decoded.discardChanges ?? false,
              }),
            };
          }),
        );
        yield* connections.tell(runnerId, frame);
        return {};
      }),

    /** Forgets an existing checkout's registration while leaving all of its files in place. */
    detachWorkspace: (
      id: Id,
    ): Effect.Effect<Record<string, never>, Exclude<WorkspaceError, Validation>> =>
      Effect.gen(function* () {
        yield* requireGrant("workspace.detach");
        const actor = yield* currentStamp;
        const { runnerId, frame } = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const workspace = yield* workspaces.detachable(id);
            return {
              runnerId: workspace.runnerId,
              frame: yield* workspaces.reserveDetachment(workspace, actor),
            };
          }),
        );
        yield* connections.tell(runnerId, frame);
        return {};
      }),

    /** Runs forever. Sweeps expired workspaces on an interval. */
    driving: Effect.gen(function* () {
      const interval = yield* WorkspaceSweepInterval;
      while (true) {
        yield* Effect.sleep(interval);
        yield* absorbFailures("Sweeping expired workspaces failed", promotion.whenServing(sweep));
      }
    }),
  };
});

export class Provisioning extends Context.Service<Provisioning, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Provisioning",
) {}

export const ProvisioningLayer: Layer.Layer<
  Provisioning,
  never,
  SqlClient.SqlClient | WorkspaceService | RunnerConnections | PromotionState
> = Layer.effect(Provisioning)(make);
