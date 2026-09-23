/**
 * The workflow actions a step can call: the row the catalog holds for each
 * one, and the live input schema that a step's params are read against.
 *
 * A plugin registers its actions through the host, and the core registers its
 * built-in actions into the same catalog at every boot, so validation and every
 * picker read one list. It sits beside the host rather than inside it because
 * the host's registration surface is a list of extension points, and the whole
 * of what one of them takes belongs in one place. A leaf: the host calls this,
 * and this calls nothing of the host's.
 */
import * as Effect from "effect/Effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import {
  PluginError,
  WorkflowActionNames,
  type WorkflowActionContribution,
} from "@hercule/plugin-host";
import {
  Id,
  MAX_PLUGIN_MESSAGE_LENGTH,
  page,
  refuseEmptyTaskUpdate,
  Task,
  TaskCreateInput,
  TaskFilter,
  TaskUpdateInput,
  type OperationId,
} from "@hercule/contract";
import { asPluginError, describeFieldIssues } from "./errors";
import { deriveCatalogJsonSchema } from "./json-schema";
import type { NewContribution } from "./repository";

/** The extension point this registers into; the column takes any name. */
const WORKFLOW_ACTION = "workflow-action";

/**
 * The owner of every contribution the core declares, in the catalog. The core
 * is not a plugin, so it has no row in `plugins` and it is never disabled. No
 * plugin can have this id.
 */
export const CORE_CONTRIBUTION_OWNER = "core";

/**
 * One workflow action a boot registered. `id` is the id a step names it by:
 * `<pluginId>/<word>` for a plugin's action, and the operation's id for a
 * built-in action.
 */
export interface RegisteredWorkflowAction {
  readonly id: string;
  /**
   * The id of the plugin that declared the action, or `core` for a built-in
   * action, which a step can always name.
   */
  readonly owner: string;
  readonly displayName: string;
  readonly description: string;
  /** The params a step writes, as the JSON Schema the catalog holds. */
  readonly inputSchema: JsonSchema.JsonSchema;
  /** The same params as a live schema, which a literal param is decoded against. */
  readonly input: Schema.Top;
}

/**
 * What a workflow action says about itself besides its two names. Both fields
 * reach a column and the wire, so they are bounded where the plugin is told.
 */
const WorkflowActionHeader = Schema.Struct({
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PLUGIN_MESSAGE_LENGTH),
  ),
  connection: Schema.optionalKey(
    Schema.Struct({ type: Schema.String.check(Schema.isMinLength(1)) }),
  ),
});

const decodeWorkflowActionNames = Schema.decodeUnknownEffect(WorkflowActionNames, {
  errors: "all",
});

const decodeWorkflowActionHeader = Schema.decodeUnknownEffect(WorkflowActionHeader, {
  errors: "all",
});

/**
 * One workflow action as the core or a plugin declares it, with the id a step
 * names it by.
 */
interface DeclaredWorkflowAction {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly connection?: { readonly type: string };
}

/**
 * Adds one action to both collections of the registration pass. They are the
 * pass's own, handed in and appended to, because a pass registers every
 * plugin before any of it is stored: a plugin whose registration fails leaves
 * nothing behind in the collections the boot keeps.
 */
const addWorkflowAction = (
  owner: string,
  action: DeclaredWorkflowAction,
  declared: Array<NewContribution>,
  actions: Map<string, RegisteredWorkflowAction>,
): void => {
  const inputSchema = deriveCatalogJsonSchema(action.input);
  declared.push({
    owner,
    extensionPoint: WORKFLOW_ACTION,
    id: action.id,
    definition: {
      displayName: action.displayName,
      description: action.description,
      inputSchema,
      outputSchema: deriveCatalogJsonSchema(action.output),
      ...(action.connection === undefined ? {} : { connection: action.connection }),
    },
  });
  actions.set(action.id, {
    id: action.id,
    owner,
    displayName: action.displayName,
    description: action.description,
    inputSchema,
    input: action.input,
  });
};

/**
 * Registers one action a plugin declares. The host makes the id a step names
 * it by from the plugin's id and the word the plugin declared. `execute` stays
 * with the plugin: nothing calls it until runs execute action steps.
 */
export const registerWorkflowActionContribution = (
  pluginId: string,
  contribution: WorkflowActionContribution,
  declared: Array<NewContribution>,
  actions: Map<string, RegisteredWorkflowAction>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const names = yield* Effect.mapError(
      decodeWorkflowActionNames({ id: contribution.id, displayName: contribution.displayName }),
      asPluginError,
    );
    const id = `${pluginId}/${names.id}`;
    const header = yield* Effect.mapError(
      decodeWorkflowActionHeader({
        description: contribution.description,
        ...(contribution.connection === undefined ? {} : { connection: contribution.connection }),
      }),
      (error) =>
        new PluginError({
          message: `the workflow action ${id} is refused: ${describeFieldIssues(error)}`,
        }),
    );
    if (actions.has(id)) {
      return yield* Effect.fail(
        new PluginError({
          message: `the ${WORKFLOW_ACTION} contribution ${id} is registered twice`,
        }),
      );
    }
    // A step writes its params as named fields, so the checks at save read
    // the input as a struct: which fields exist, and which are required.
    if (!SchemaAST.isObjects(contribution.input.ast)) {
      return yield* Effect.fail(
        new PluginError({
          message: `the workflow action ${id} is refused: its input must be a struct, because a step writes its params as named fields`,
        }),
      );
    }
    addWorkflowAction(
      pluginId,
      {
        id,
        displayName: names.displayName,
        description: header.description,
        input: contribution.input,
        output: contribution.output,
        ...(header.connection === undefined ? {} : { connection: header.connection }),
      },
      declared,
      actions,
    );
  });

/**
 * The actions the core declares. Each one is an operation of the public API,
 * with the operation's id, so a step reaches nothing through an action that a
 * request cannot reach. The other built-in actions join this list with the
 * operations they call.
 */
const BUILT_IN_WORKFLOW_ACTIONS: ReadonlyArray<
  DeclaredWorkflowAction & { readonly id: OperationId }
> = [
  {
    id: "task.create",
    displayName: "Create a task",
    description:
      "Creates one Task from a title and a description, with an optional priority, labels, project and provenance.",
    input: TaskCreateInput,
    output: Task,
  },
  {
    id: "task.update",
    displayName: "Update a task",
    description:
      "Changes the fields of the Task that taskId names. A field that the params leave out stays as it is.",
    // The operation's input, with the task named in the params, because a
    // request names it in the path. The edit is refused when it names no
    // field to change, by the rule the operation's input carries.
    input: Schema.Struct({ taskId: Id, ...TaskUpdateInput.fields }).check(refuseEmptyTaskUpdate),
    output: Task,
  },
  {
    id: "task.query",
    displayName: "Find tasks",
    description: "Lists the Tasks that match refs, labels, status, project or text.",
    // The filter of the operation, without the operation's paging fields. A
    // step reads the answer to decide where the run goes next, such as whether
    // a Task for the event exists already, and the first page answers that.
    input: TaskFilter,
    output: page(Task),
  },
];

/** Registers the built-in actions, owned by the core, into the collections of a pass. */
export const registerBuiltInWorkflowActions = (
  declared: Array<NewContribution>,
  actions: Map<string, RegisteredWorkflowAction>,
): void => {
  for (const action of BUILT_IN_WORKFLOW_ACTIONS) {
    addWorkflowAction(CORE_CONTRIBUTION_OWNER, action, declared, actions);
  }
};
