/**
 * The runs domain's implementation of `WorkspaceStepActivity`, the port the
 * workspaces domain declares for its git credential rule. Whether a workspace
 * step is running is a fact about step records, which belong to this domain,
 * so the question is answered here rather than by SQL over `runs` in the
 * workspaces domain.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { runsInWorkspace } from "../plugins";
import { WorkspaceStepActivity } from "../workspaces";
import { runRepository } from "./repository";

export const RunWorkspaceStepActivityLayer: Layer.Layer<
  WorkspaceStepActivity,
  never,
  SqlClient.SqlClient
> = Layer.effect(WorkspaceStepActivity)(
  Effect.gen(function* () {
    const runs = yield* runRepository;
    return {
      isStepRunning: (workspaceId, runnerId) =>
        Effect.map(runs.listRunningStepsPinnedTo(runnerId), (records) =>
          records.some(
            (record) => record.workspaceId === workspaceId && runsInWorkspace(record.action),
          ),
        ),
    };
  }),
);
