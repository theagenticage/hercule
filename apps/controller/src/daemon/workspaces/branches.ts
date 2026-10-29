/**
 * The branches of a repo on one runner, read live from the runner.
 *
 * The controller stores no branch lists: a repository can have tens of
 * thousands of branches, and sending them all with every workspace made the
 * workspace list too large to load. The runner reads them from the repo's
 * main workspace when a client asks, filtered and cut to a limit. Asking a
 * runner means sending it a frame, so this use case lives in the controller
 * daemon.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { BRANCH_LIST_CAPABILITY } from "@hercule/protocol";
import {
  createNotFoundError,
  DEFAULT_MAX_BRANCHES,
  type Forbidden,
  type NotFound,
  type ResourceBranches,
  type ResourceBranchFilter,
  type Validation,
} from "@hercule/contract";
import { requireGrant } from "../../actor";
import { mintUuid, uuidToString } from "../../db";
import { NO_SUCH_RESOURCE, resourceRepository } from "../../resources";
import { readRunnerOrFail, RunnerConnections, runnerRepository } from "../../runners";
import { requireCheckedOut, WorkspaceService } from "../../workspaces";

/**
 * How long to wait for a runner to list branches. One `git for-each-ref` is
 * fast even with many branches; the deadline covers a slow or busy machine.
 */
const LISTING_DEADLINE = Duration.seconds(10);

const buildUnavailable = (reason: string): ResourceBranches => ({
  local: [],
  remote: [],
  more: false,
  unavailableReason: reason,
});

const make = Effect.gen(function* () {
  const resources = yield* resourceRepository;
  const runners = yield* runnerRepository;
  const workspaces = yield* WorkspaceService;
  const connections = yield* RunnerConnections;
  const readRunner = readRunnerOrFail(runners);

  return {
    /**
     * Returns the branches of a repo as the runner reads them now from the
     * repo's main workspace there: the local branches and those of its
     * remote, each newest first, filtered by `text` and cut to `maxBranches`.
     *
     * A runner that cannot list them is not an error, because a client still
     * offers the choices that need no list. The answer then has empty lists
     * and `unavailableReason`, which says what to do:
     *
     * - the runner has no ready main workspace of the repo;
     * - the runner is too old to list branches;
     * - the runner is offline or did not answer in time;
     * - git failed on the runner.
     *
     * Fails with `Forbidden` when the caller lacks `workspace.read`, with
     * `NotFound` when no resource or no runner has the id, and with
     * `Validation` when the resource is not a repo.
     */
    listBranches: (
      resourceId: string,
      filter: ResourceBranchFilter,
    ): Effect.Effect<ResourceBranches, Forbidden | NotFound | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("resource.listBranches");
        const resource = (yield* resources.byIds([resourceId])).get(resourceId);
        if (resource === undefined)
          return yield* Effect.fail(createNotFoundError(NO_SUCH_RESOURCE));
        yield* requireCheckedOut(resource);
        const runner = yield* readRunner(filter.runnerId);
        const workspaceId = yield* workspaces.readReadyPrimaryId(resourceId, runner.id);
        if (Option.isNone(workspaceId))
          return buildUnavailable(
            `The runner \`${runner.name}\` has no ready main workspace of this repo, so its branches cannot be listed. Prepare one, or start from the current working copy or the remote default.`,
          );
        if (!(runner.negotiatedCapabilities ?? []).includes(BRANCH_LIST_CAPABILITY))
          return buildUnavailable(
            `The runner \`${runner.name}\` is too old to list branches. Update it to choose a branch.`,
          );
        const answer = yield* connections.asked(
          runner.id,
          {
            _tag: "branchListRequest",
            requestId: uuidToString(mintUuid()),
            workspaceId: workspaceId.value,
            text: filter.text ?? "",
            maxBranches: filter.maxBranches ?? DEFAULT_MAX_BRANCHES,
          },
          LISTING_DEADLINE,
        );
        if (
          Option.isNone(answer) ||
          answer.value._tag !== "branchListReport" ||
          answer.value.workspaceId !== workspaceId.value
        )
          return buildUnavailable(
            `The runner \`${runner.name}\` is offline or did not answer in time, so branches cannot be listed. Check that it is online and try again.`,
          );
        const { outcome } = answer.value;
        if (outcome.status === "failed")
          return buildUnavailable(
            `The runner \`${runner.name}\` could not list branches: ${outcome.message}`,
          );
        return { local: outcome.local, remote: outcome.remote, more: outcome.more };
      }),
  };
});

export class RepositoryBranches extends Context.Service<
  RepositoryBranches,
  Effect.Success<typeof make>
>()("hercule/controller/daemon/RepositoryBranches") {}

export const RepositoryBranchesLayer: Layer.Layer<
  RepositoryBranches,
  never,
  SqlClient.SqlClient | WorkspaceService | RunnerConnections
> = Layer.effect(RepositoryBranches)(make);
