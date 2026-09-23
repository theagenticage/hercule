/**
 * Registers workflow actions: the actions a workflow step can call. Each
 * action gets a catalog row, and its input schema is kept so that a step's
 * params can be validated against it.
 *
 * Plugins register their actions through the host. The core registers its
 * built-in actions into the same catalog at every boot, so validation and
 * every action picker read one list.
 *
 * This module sits beside the host rather than inside it, so that all the code
 * for one extension point is in one place. The host calls this module, and
 * this module calls nothing in the host.
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
import { toPluginError, describeFieldIssues } from "./errors";
import { deriveCatalogJsonSchema } from "./json-schema";
import type { NewContribution } from "./repository";

/** The name of the extension point this module registers into. */
const WORKFLOW_ACTION = "workflow-action";

/**
 * The owner id of the built-in contributions in the catalog. The core is not
 * a plugin, so it has no row in `plugins` and cannot be disabled. No plugin
 * can use this id.
 */
export const CORE_CONTRIBUTION_OWNER = "core";

/**
 * A workflow action registered at boot. `id` is the id a step uses to call
 * the action: `<pluginId>/<word>` for a plugin's action, and the operation id
 * for a built-in action.
 */
export interface RegisteredWorkflowAction {
  readonly id: string;
  /**
   * The id of the plugin that declared the action, or `core` for a built-in
   * action. A step can always call a built-in action.
   */
  readonly owner: string;
  readonly displayName: string;
  readonly description: string;
  /** The schema of the params a step writes, as JSON Schema. */
  readonly inputSchema: JsonSchema.JsonSchema;
  /** The same schema as an Effect schema, used to decode literal params. */
  readonly input: Schema.Top;
}

/**
 * The fields of a workflow action, other than its id and display name, that
 * are validated at registration. Both are stored in a column and sent over
 * the API, so their length is checked here, where the plugin author gets the
 * error.
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

/** A workflow action as the core or a plugin declares it, with its qualified id. */
interface DeclaredWorkflowAction {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly connection?: { readonly type: string };
}

/**
 * Adds one action to the catalog rows in `declared` and to the `actions` map.
 *
 * Both collections belong to the current registration pass. The pass
 * registers every plugin before it stores anything, so a plugin whose
 * registration fails leaves nothing in the collections the boot keeps.
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
 * Validates and registers one workflow action that a plugin declares. The
 * qualified id is `<pluginId>/<word>`. Fails with a `PluginError` if a field
 * is invalid, the id is already registered, or the input schema is not a
 * struct.
 *
 * `execute` is not stored here: nothing calls it until runs execute action
 * steps.
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
      toPluginError,
    );
    const id = `${pluginId}/${names.id}`;
    const header = yield* Effect.mapError(
      decodeWorkflowActionHeader({
        description: contribution.description,
        ...(contribution.connection === undefined ? {} : { connection: contribution.connection }),
      }),
      (error) =>
        new PluginError({
          message: `the workflow action ${id} is invalid: ${describeFieldIssues(error)}`,
        }),
    );
    if (actions.has(id)) {
      return yield* Effect.fail(
        new PluginError({
          message: `the ${WORKFLOW_ACTION} contribution ${id} is registered twice`,
        }),
      );
    }
    // A step writes its params as named fields. Validation at save reads the
    // input schema as a struct to find which fields exist and which are
    // required.
    if (!SchemaAST.isObjects(contribution.input.ast)) {
      return yield* Effect.fail(
        new PluginError({
          message: `the workflow action ${id} is invalid: its input schema must be a struct, because a step writes its params as named fields`,
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
 * The built-in workflow actions. Each one calls an operation of the public API
 * and has the operation's id, so a step can do nothing that an API request
 * cannot do. More built-in actions are added here as their operations are
 * built.
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
      "Changes fields of the Task with the id taskId. Fields left out of the params are not changed.",
    // The operation's input plus `taskId`, because an API request sends the
    // task id in the path and a step has no path. The check is the one the
    // operation uses, so both reject an update that changes no field.
    input: Schema.Struct({ taskId: Id, ...TaskUpdateInput.fields }).check(refuseEmptyTaskUpdate),
    output: Task,
  },
  {
    id: "task.query",
    displayName: "Find tasks",
    description: "Lists the Tasks that match refs, labels, status, project or text.",
    // The operation's filter, without the paging fields. A step uses the
    // result to decide what the run does next, for example whether a Task for
    // the event already exists. The first page is enough for that.
    input: TaskFilter,
    output: page(Task),
  },
];

/** Adds the built-in actions, owned by `core`, to the collections of a registration pass. */
export const registerBuiltInWorkflowActions = (
  declared: Array<NewContribution>,
  actions: Map<string, RegisteredWorkflowAction>,
): void => {
  for (const action of BUILT_IN_WORKFLOW_ACTIONS) {
    addWorkflowAction(CORE_CONTRIBUTION_OWNER, action, declared, actions);
  }
};
