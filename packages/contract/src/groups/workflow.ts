/**
 * Workflows: named, stored sources of execution plans, written as YAML. This
 * module holds the records and the operations of the API. What the text says,
 * `WorkflowDefinition`, is in `./workflow-definition`.
 *
 * `enabled`, the timestamps and the status of each start trigger are state of
 * the stored row and not part of the text, so turning a workflow on or
 * pausing a trigger never rewrites what the author wrote.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { closedStruct } from "../closed";
import { Forbidden, Internal, Issue, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { WorkflowDefinition } from "./workflow-definition";

/** A workflow as it is stored: the text exactly as written, and the row around it. */
export const Workflow = Schema.Struct({
  id: Id,
  /** Whether the workflow's triggers match. A new workflow is off until someone turns it on. */
  enabled: Schema.Boolean,
  /** The YAML text, byte for byte as the author wrote it. */
  source: Schema.String,
  createdAt: Timestamp,
  /**
   * When the text last changed. Turning the workflow on or off does not move
   * it, and a save of the same text does not move it either.
   */
  updatedAt: Timestamp,
});

export type Workflow = Schema.Schema.Type<typeof Workflow>;

/** One workflow in a listing: what its definition calls it, and whether it is on. */
export const WorkflowSummary = Schema.Struct({
  id: Id,
  name: Schema.String,
  /** Absent when the definition has none. */
  description: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  /**
   * When the text last changed. Turning the workflow on or off does not move
   * it, and a save of the same text does not move it either.
   */
  updatedAt: Timestamp,
});

export type WorkflowSummary = Schema.Schema.Type<typeof WorkflowSummary>;

/** What a save answers with: the stored workflow, and the warnings about what it stored. */
export const WorkflowSaved = Schema.Struct({
  workflow: Workflow,
  /** Problems that do not stop the save. */
  warnings: Schema.Array(Issue),
});

export type WorkflowSaved = Schema.Schema.Type<typeof WorkflowSaved>;

/**
 * A definition object as a caller sends it, before the controller checks it.
 * The transport takes any JSON value here, and the controller checks the value
 * with `decodeWorkflowDefinition`: a mistake is then named the same way
 * whether a text or an object carried it, with every problem at once. The
 * guard accepts every value for that reason, and so it only says what type a
 * caller must send. That type, and the JSON Schema the OpenAPI document shows,
 * are the definition's own, so a client is written against the shape that the
 * controller then checks.
 */
const UncheckedDefinition = Schema.Json.pipe(
  // The guard accepts every value on purpose, so it reads none.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  Schema.refine((_: Schema.Json): _ is WorkflowDefinition => true, {
    description: "A workflow definition: the object the YAML source says, written as JSON.",
    representation: { id: "WorkflowDefinition", payload: null, schemas: [WorkflowDefinition.ast] },
    toJsonSchema: ({ schemas }) => schemas[0]!,
  }),
);

/**
 * The two ways a save may send what a workflow says: its text, or a
 * definition object. Both are checked by the controller, with
 * `parseWorkflowSource` and `decodeWorkflowDefinition`, and not by the
 * transport.
 */
const WORKFLOW_CONTENT_FIELDS = {
  /** Stored byte for byte. */
  source: Schema.optionalKey(Schema.String),
  /** Stored as its canonical text. */
  definition: Schema.optionalKey(UncheckedDefinition),
};

/**
 * What creating a workflow takes: the text, or a definition object that is
 * stored as its canonical text. Exactly one of the two.
 */
export const WorkflowCreateInput = closedStruct(WORKFLOW_CONTENT_FIELDS);

export type WorkflowCreateInput = Schema.Schema.Type<typeof WorkflowCreateInput>;

/**
 * The fields an edit of a workflow may send: a new text or a new definition
 * object, and whether the workflow is on. At most one of the text and the
 * object. The service adds the workflow's id to them.
 */
export const WORKFLOW_UPDATE_FIELDS = {
  ...WORKFLOW_CONTENT_FIELDS,
  /** Turns the workflow's triggers on or off. The text does not change. */
  enabled: Schema.optionalKey(Schema.Boolean),
};

export const WorkflowUpdateInput = closedStruct(WORKFLOW_UPDATE_FIELDS);

export type WorkflowUpdateInput = Schema.Schema.Type<typeof WorkflowUpdateInput>;

/**
 * What checking a workflow takes: the text, or a definition object, as a
 * create takes them. Exactly one of the two.
 */
export const WorkflowValidateInput = closedStruct(WORKFLOW_CONTENT_FIELDS);

export type WorkflowValidateInput = Schema.Schema.Type<typeof WorkflowValidateInput>;

/**
 * What a check of a workflow finds. A save of the same content is refused with
 * `errors`, in the same order, and answers `warnings` beside the stored
 * workflow. Both are empty for a workflow that a save stores with no warning.
 */
export const WorkflowIssues = Schema.Struct({
  /** Problems that stop a save. */
  errors: Schema.Array(Issue),
  /** Problems that do not stop a save. */
  warnings: Schema.Array(Issue),
});

export type WorkflowIssues = Schema.Schema.Type<typeof WorkflowIssues>;

/** What narrows a workflow listing. */
export const WorkflowFilter = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
});

/** What a workflow listing may be sorted by. */
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
      success: WorkflowSaved,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.patch("update", "/workflows/:id", {
      params: { id: Id },
      payload: WorkflowUpdateInput,
      success: WorkflowSaved,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/workflows/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Checks a workflow as a save does and stores nothing. A workflow with
     * problems is still a successful check: the problems are the answer. Only
     * a request that sends no content, or two, is refused.
     */
    HttpApiEndpoint.post("validate", "/workflows/validate", {
      payload: WorkflowValidateInput,
      success: WorkflowIssues,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
  )
  .middleware(Authenticated);
