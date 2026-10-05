/**
 * Workflow actions: what an action step can call. The core declares its
 * built-in actions, each one an operation of this API with the operation's
 * id. Every running plugin declares its own actions, each named
 * `<pluginId>/<word>`. The list is the complete catalog of actions a step can
 * call right now, and it is short, so it has no filter and no paging.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated } from "../errors";
import { Authenticated } from "../security";

/**
 * Where a workflow action runs, a fixed property of the action:
 *
 * - `controller`: the controller calls it. Every plugin action runs here.
 * - `workspace`: the run's runner runs it in the run's workspace, such as
 *   `git.commit`. The run's first such step pins the run to a runner.
 */
export const WorkflowActionRunsIn = Schema.Literals(["controller", "workspace"]);

export type WorkflowActionRunsIn = Schema.Schema.Type<typeof WorkflowActionRunsIn>;

/** A workflow action that a step can call, and the params it takes. */
export const WorkflowAction = Schema.Struct({
  /** What a step writes after `action:`: an operation id, or `<pluginId>/<word>`. */
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  runsIn: WorkflowActionRunsIn,
  /**
   * The JSON Schema of the params the action decodes. Typed as an open record,
   * because a JSON Schema object can hold any keyword. An action with
   * `connection` takes one more param that this schema leaves out: see
   * `connection`.
   */
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  /**
   * Present when the action acts through a Connection: `type` is the
   * qualified Connection type, such as `github/github`. A step that calls the
   * action must also write the param `connection`, set to the id of a
   * Connection of this type or to a template such as
   * `{{ inputs.account }}`. That param is not in `inputSchema`, because the
   * core reads it to pick the Connection and the action never receives it.
   */
  connection: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
});

export type WorkflowAction = Schema.Schema.Type<typeof WorkflowAction>;

export const workflowAction = HttpApiGroup.make("workflowAction")
  .add(
    HttpApiEndpoint.get("query", "/workflow-actions", {
      success: Schema.Array(WorkflowAction),
      error: [Unauthenticated, Forbidden, Internal],
    }),
  )
  .middleware(Authenticated);
