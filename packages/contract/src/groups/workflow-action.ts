/**
 * Workflow actions: what an action step can call. The core declares its
 * built-in actions, each one an operation of this API with the operation's id,
 * and every plugin that runs declares its own, each one named
 * `<pluginId>/<word>`. The listing is the whole catalog a step can name now,
 * so it has no filter and no paging.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, Unauthenticated } from "../errors";
import { Authenticated } from "../security";

/** A workflow action that a step can name, and the params it takes. */
export const WorkflowAction = Schema.Struct({
  /** What a step writes after `action:`: an operation id, or `<pluginId>/<word>`. */
  id: Schema.String,
  displayName: Schema.String,
  description: Schema.String,
  /**
   * The params a step writes, as one JSON Schema object with the keywords at
   * its top. An open record, because a JSON Schema node may hold any keyword.
   */
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
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
