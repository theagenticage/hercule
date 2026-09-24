/**
 * Workflows: named, stored sources of execution plans, written as YAML. This
 * module holds the workflow records and the API operations. The schema of the
 * parsed YAML, `WorkflowDefinition`, is in `./workflow-definition`.
 *
 * `enabled`, the timestamps and the status of each start trigger are stored
 * on the row, not in the YAML source, so enabling a workflow or pausing a
 * trigger never changes what the author wrote.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import { Forbidden, Internal, Issue, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { workflowRunEndpoint } from "./run";
import { WorkflowDefinition } from "./workflow-definition";

/** A stored workflow: its YAML source exactly as written, plus the stored row's fields. */
export const Workflow = Schema.Struct({
  id: Id,
  /** Whether the workflow's triggers match events. A new workflow is disabled until someone enables it. */
  enabled: Schema.Boolean,
  /** The YAML source, byte for byte as the author wrote it. */
  source: Schema.String,
  createdAt: Timestamp,
  /**
   * When the source last changed. Enabling or disabling the workflow does not
   * change this timestamp, and neither does saving the same source again.
   */
  updatedAt: Timestamp,
});

export type Workflow = Schema.Schema.Type<typeof Workflow>;

/** One workflow in the workflow list: its name and description from the source, and whether it is enabled. */
export const WorkflowSummary = Schema.Struct({
  id: Id,
  name: Schema.String,
  /** Absent when the source sets none. */
  description: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  /**
   * When the source last changed. Enabling or disabling the workflow does not
   * change this timestamp, and neither does saving the same source again.
   */
  updatedAt: Timestamp,
});

export type WorkflowSummary = Schema.Schema.Type<typeof WorkflowSummary>;

/** The response to a create or an update: the stored workflow, and any warnings about it. */
export const WorkflowSaveResult = Schema.Struct({
  workflow: Workflow,
  /** Problems that do not block the save. */
  warnings: Schema.Array(Issue),
});

export type WorkflowSaveResult = Schema.Schema.Type<typeof WorkflowSaveResult>;

/**
 * A definition object as a caller sends it, before the controller validates
 * it. The transport accepts any JSON value here. The controller then validates
 * the value with `decodeWorkflowDefinition`, so an error is reported the same
 * way whether it came in YAML text or in an object, and all errors are
 * reported at once.
 *
 * So the type guard below accepts every value, and exists only to give the
 * field its TypeScript type. That type and the JSON Schema in the OpenAPI
 * document are both `WorkflowDefinition`, so clients are written against the
 * structure the controller validates.
 */
const UncheckedDefinition = Schema.Json.pipe(
  // The guard accepts every value on purpose, so it never reads its argument.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  Schema.refine((_: Schema.Json): _ is WorkflowDefinition => true, {
    description:
      "A workflow definition as a JSON object: the structure that the YAML source parses to.",
    representation: { id: "WorkflowDefinition", payload: null, schemas: [WorkflowDefinition.ast] },
    toJsonSchema: ({ schemas }) => schemas[0]!,
  }),
);

/**
 * The two ways a request can send a workflow: as YAML text, or as a
 * definition object. The controller validates both, with `parseWorkflowSource`
 * and `decodeWorkflowDefinition`. The transport does not validate them.
 */
const WORKFLOW_CONTENT_FIELDS = {
  /** Stored byte for byte. */
  source: Schema.optionalKey(Schema.String),
  /** Converted to YAML and stored as that YAML. */
  definition: Schema.optionalKey(UncheckedDefinition),
};

/**
 * The input of a workflow create: either `source` or `definition`, not both.
 * A definition is converted to YAML before it is stored.
 */
export const WorkflowCreateInput = closedStruct(WORKFLOW_CONTENT_FIELDS);

export type WorkflowCreateInput = Schema.Schema.Type<typeof WorkflowCreateInput>;

/**
 * The fields a workflow update can send: a new `source` or a new
 * `definition` (at most one of the two), and `enabled`. The controller's
 * service adds the workflow's id to these fields.
 */
export const WORKFLOW_UPDATE_FIELDS = {
  ...WORKFLOW_CONTENT_FIELDS,
  /** Enables or disables the workflow's triggers. The source does not change. */
  enabled: Schema.optionalKey(Schema.Boolean),
};

export const WorkflowUpdateInput = closedStruct(WORKFLOW_UPDATE_FIELDS);

export type WorkflowUpdateInput = Schema.Schema.Type<typeof WorkflowUpdateInput>;

/** The input of a workflow validation: either `source` or `definition`, as for a create. */
export const WorkflowValidateInput = closedStruct(WORKFLOW_CONTENT_FIELDS);

export type WorkflowValidateInput = Schema.Schema.Type<typeof WorkflowValidateInput>;

/**
 * The result of validating a workflow. Saving the same workflow would fail
 * with the same `errors`, in the same order, or succeed and return the same
 * `warnings`. Both lists are empty when a save would succeed with no warnings.
 */
export const WorkflowIssues = Schema.Struct({
  /** Problems that block a save. */
  errors: Schema.Array(Issue),
  /** Problems that do not block a save. */
  warnings: Schema.Array(Issue),
});

export type WorkflowIssues = Schema.Schema.Type<typeof WorkflowIssues>;

/** Filters for the workflow list. */
export const WorkflowFilter = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});

/** The fields the workflow list can be sorted by. */
export const WORKFLOW_SORT_FIELDS = ["updatedAt"] as const;

export const workflow = HttpApiGroup.make("workflow")
  .add(
    HttpApiEndpoint.get("query", "/workflows", {
      query: Schema.Struct({
        ...WorkflowFilter.fields,
        ...pageParams(WORKFLOW_SORT_FIELDS).fields,
      }),
      success: page(WorkflowSummary),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/workflows/:id", {
      params: { id: Id },
      success: Workflow,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/workflows", {
      payload: WorkflowCreateInput,
      success: WorkflowSaveResult,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.patch("update", "/workflows/:id", {
      params: { id: Id },
      payload: WorkflowUpdateInput,
      success: WorkflowSaveResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/workflows/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Validates a workflow the same way a save does, but stores nothing. A
     * workflow with errors still gives a successful response, with the errors
     * in the body. The request itself fails only when it sends neither
     * `source` nor `definition`, or both.
     */
    HttpApiEndpoint.post("validate", "/workflows/validate", {
      payload: WorkflowValidateInput,
      success: WorkflowIssues,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    workflowRunEndpoint,
  )
  .middleware(Authenticated);
