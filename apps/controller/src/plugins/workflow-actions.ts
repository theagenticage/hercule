/**
 * Registers workflow actions: the actions a workflow step can call. Each
 * action gets a catalog row, and its input schema is kept so that a step's
 * params can be validated against it.
 *
 * Plugins register their actions through the host. The core registers its
 * built-in actions into the same catalog at every boot, so validation and
 * every action picker read one list.
 *
 * Every action says where it runs (`runsIn`), and that is a fixed property of
 * the action, never a choice the step makes:
 *
 * - `controller`: the controller calls the action. Every plugin action runs
 *   here, because plugins load only on the controller (ADR 0006).
 * - `workspace`: a runner runs the action in the run's workspace. Only the
 *   core declares such actions, such as `git.commit`. The catalog holds their
 *   id and schemas, for validation and pickers, and their code is built into
 *   the runner.
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
  RunInputs,
  RunStarted,
  Task,
  TaskCreateInput,
  TaskFilter,
  TaskUpdateInput,
  type OperationId,
  type WorkflowActionRunsIn,
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
 * for a built-in action, except `wait`, which calls no operation.
 */
export interface RegisteredWorkflowAction {
  readonly id: string;
  /**
   * The id of the plugin that declared the action, or `core` for a built-in
   * action. A step can always call a built-in action.
   */
  readonly owner: string;
  /** Where the action runs: on the controller, or in the run's workspace on a runner. */
  readonly runsIn: WorkflowActionRunsIn;
  readonly displayName: string;
  readonly description: string;
  /** The schema of the params a step writes, as JSON Schema. */
  readonly inputSchema: JsonSchema.JsonSchema;
  /** The same schema as an Effect schema, used to decode literal params. */
  readonly input: Schema.Top;
  /** The schema of what the action returns, used to check a plugin action's result. */
  readonly output: Schema.Top;
  /** The qualified type of the Connection the action acts through, if it uses one. */
  readonly connection?: { readonly type: string };
  /**
   * Carries out a plugin's action. A built-in action has none: the run engine
   * calls the operation's service method itself, because the catalog sits
   * below the domains those methods belong to.
   */
  readonly execute?: WorkflowActionContribution["execute"];
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
  readonly runsIn: WorkflowActionRunsIn;
  readonly displayName: string;
  readonly description: string;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
  readonly connection?: { readonly type: string };
  readonly execute?: WorkflowActionContribution["execute"];
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
    runsIn: action.runsIn,
    displayName: action.displayName,
    description: action.description,
    inputSchema,
    input: action.input,
    output: action.output,
    ...(action.connection === undefined ? {} : { connection: action.connection }),
    ...(action.execute === undefined ? {} : { execute: action.execute }),
  });
};

/**
 * Validates and registers one workflow action that a plugin declares. The
 * qualified id is `<pluginId>/<word>`. Fails with a `PluginError` if a field
 * is invalid, the id is already registered, or the input schema is not a
 * struct.
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
        // A plugin runs only on the controller, so its actions do too.
        runsIn: "controller",
        displayName: names.displayName,
        description: header.description,
        input: contribution.input,
        output: contribution.output,
        ...(header.connection === undefined ? {} : { connection: header.connection }),
        execute: contribution.execute,
      },
      declared,
      actions,
    );
  });

/** The longest a `wait` step can wait: one day, in seconds. */
const MAX_WAIT_SECONDS = 86_400;

/**
 * A built-in action as it is written in the list below. The union makes the
 * split by `runsIn` hold at compile time:
 *
 * - An action that runs on the controller calls an operation of the public
 *   API and has the operation's id, so a step can do nothing that an API
 *   request cannot do. The one exception is `wait`, which acts on nothing, so
 *   there is no operation for it to call. The run engine holds a handler for
 *   each of these actions.
 * - An action that runs in the workspace has no operation and no handler on
 *   the controller. The runner carries it out.
 */
type BuiltInWorkflowAction = DeclaredWorkflowAction &
  (
    | { readonly runsIn: "controller"; readonly id: OperationId | "wait" }
    | { readonly runsIn: "workspace"; readonly execute?: never }
  );

/**
 * The built-in workflow actions. More are added here as their operations, or
 * their runner code, are built.
 */
const BUILT_IN_WORKFLOW_ACTIONS = [
  {
    id: "task.create",
    runsIn: "controller",
    displayName: "Create a task",
    description:
      "Creates one Task from a title and a description, with an optional priority, labels, project and provenance. The task's provenance also records the run that created it.",
    input: TaskCreateInput,
    output: Task,
  },
  {
    id: "task.update",
    runsIn: "controller",
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
    runsIn: "controller",
    displayName: "Find tasks",
    description: "Lists the Tasks that match refs, labels, status, project or text.",
    // The operation's filter, without the paging fields. A step uses the
    // result to decide what the run does next, for example whether a Task for
    // the event already exists. The first page is enough for that.
    input: TaskFilter,
    output: page(Task),
  },
  {
    id: "run.start",
    runsIn: "controller",
    displayName: "Start a run",
    description:
      "Starts a run of the stored workflow with the id workflowId, and does not wait for it to finish. The output holds the new run's id.",
    // Of the operation's input, only a stored workflow: a step that starts a
    // run of a workflow written into its own params would be a sub-workflow,
    // which is not built yet.
    input: Schema.Struct({ workflowId: Id, inputs: Schema.optionalKey(RunInputs) }),
    output: RunStarted,
  },
  {
    id: "wait",
    runsIn: "controller",
    displayName: "Wait",
    description: `Waits the given number of seconds, from 1 to ${MAX_WAIT_SECONDS} (one day), before the run goes on. Cancelling the run ends the wait.`,
    input: Schema.Struct({
      seconds: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_WAIT_SECONDS })),
    }),
    output: Schema.Struct({}),
  },
  {
    id: "git.commit",
    runsIn: "workspace",
    displayName: "Commit changes",
    description:
      "Commits the changes in the run's workspace to the checkout's branch. paths limits the commit to those paths; without it, every change is committed. resourceId picks the checkout when the workspace has more than one. When there is nothing to commit, the step succeeds with committed false.",
    input: Schema.Struct({
      message: Schema.NonEmptyString,
      paths: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
      resourceId: Schema.optionalKey(Id),
    }),
    output: Schema.Struct({ sha: Schema.String, branch: Schema.String, committed: Schema.Boolean }),
  },
  {
    id: "git.push",
    runsIn: "workspace",
    displayName: "Push a branch",
    description:
      "Pushes a branch of the run's workspace to its remote: branch, or the checkout's branch when it is left out. resourceId picks the checkout when the workspace has more than one.",
    input: Schema.Struct({
      branch: Schema.optionalKey(Schema.NonEmptyString),
      resourceId: Schema.optionalKey(Id),
    }),
    output: Schema.Struct({ branch: Schema.String, sha: Schema.String }),
  },
] as const satisfies ReadonlyArray<BuiltInWorkflowAction>;

type BuiltInWorkflowActionEntry = (typeof BUILT_IN_WORKFLOW_ACTIONS)[number];

/** The id of a built-in workflow action that runs on the controller, and so has a handler. */
export type BuiltInControllerActionId = Extract<
  BuiltInWorkflowActionEntry,
  { readonly runsIn: "controller" }
>["id"];

/** The id of a built-in workflow action that runs in the run's workspace on a runner. */
export type WorkspaceActionId = Extract<
  BuiltInWorkflowActionEntry,
  { readonly runsIn: "workspace" }
>["id"];

const listBuiltInActionIds = (runsIn: WorkflowActionRunsIn): ReadonlySet<string> =>
  new Set(
    BUILT_IN_WORKFLOW_ACTIONS.filter((action) => action.runsIn === runsIn).map(
      (action) => action.id,
    ),
  );

const BUILT_IN_CONTROLLER_ACTION_IDS = listBuiltInActionIds("controller");
const WORKSPACE_ACTION_IDS = listBuiltInActionIds("workspace");

/** Checks whether an action id is a built-in action that runs on the controller. */
export const isBuiltInControllerActionId = (id: string): id is BuiltInControllerActionId =>
  BUILT_IN_CONTROLLER_ACTION_IDS.has(id);

/**
 * Checks whether an action id is an action that runs in the run's workspace on
 * a runner, rather than on the controller. Only built-in actions do.
 */
export const runsInWorkspace = (id: string): id is WorkspaceActionId =>
  WORKSPACE_ACTION_IDS.has(id);

/** Adds the built-in actions, owned by `core`, to the collections of a registration pass. */
export const registerBuiltInWorkflowActions = (
  declared: Array<NewContribution>,
  actions: Map<string, RegisteredWorkflowAction>,
): void => {
  for (const action of BUILT_IN_WORKFLOW_ACTIONS) {
    addWorkflowAction(CORE_CONTRIBUTION_OWNER, action, declared, actions);
  }
};
