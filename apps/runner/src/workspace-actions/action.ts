/**
 * What a workspace action is: a Workflow Action whose code runs on this
 * runner, in the run's workspace, rather than on the controller. The
 * controller's catalog declares each one with its input and output schemas;
 * its code lives here.
 */
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GitEnv, Resolved } from "../workspaces";

/** What an action is given, besides its input, to run in the run's workspace. */
export interface WorkspaceActionContext {
  /** The run's workspace on this runner. */
  readonly workspace: Resolved;
  /**
   * The resource whose checkout the action works in. Undefined when the
   * workspace has one checkout, which is then the one used.
   */
  readonly resourceId: string | undefined;
  /**
   * The environment git runs with: the runner's environment without its own
   * git variables, the runner's credential helper, and the identity commits
   * are made as when the step names one. The identity is passed as
   * configuration in the environment, never written to a config file.
   */
  readonly gitEnv: GitEnv;
}

/**
 * The action ran and failed, for example because git refused. The message is
 * shown to the user as the step's error.
 */
export class WorkspaceActionFailed extends Schema.TaggedError<WorkspaceActionFailed>()(
  "WorkspaceActionFailed",
  { message: Schema.String },
) {}

export interface WorkspaceAction {
  /** The action's id in the catalog, such as `git.commit`. */
  readonly id: string;
  /**
   * Runs the action and returns its output. `input` is the step's params as
   * the controller sent them; the action decodes them itself, because this
   * runner's build may not match the controller's catalog. Fails with
   * `WorkspaceActionFailed` when the action cannot do its work.
   */
  readonly run: (
    input: unknown,
    context: WorkspaceActionContext,
  ) => Effect.Effect<Schema.Json, WorkspaceActionFailed>;
}
