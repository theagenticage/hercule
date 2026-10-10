/**
 * The describe line of an answer: what taking it does, written from its
 * operation with the current names of what the operation acts on, such as
 * "Start a run of Bugfix". This is the `describe` half of the
 * `BoundOperations` port.
 *
 * It reads the tasks, projects, workflows, sessions, signals and Connections
 * an operation names, and those domains depend on the domains that hold Bound
 * Actions, so those domains cannot read them themselves. It reads their
 * repositories rather than their services: a describe line is part of reading
 * a notification or a signal, not a read of the task or session on the
 * caller's behalf, so their grant checks do not apply.
 *
 * Because it reads the rows directly, a read rule a service enforces applies
 * here only if this module repeats it. This module repeats one: a deleted task
 * or project reads as missing. A read rule added to a service later must be
 * added here too, or a describe line could name a row the service would hide
 * from the user.
 *
 * The user decides from this line, so it shows everything the operation will
 * run in full: the text an answer sends, every changed field, every run input.
 * Nothing is cut short or left out; a screen that runs out of room wraps.
 *
 * A plugin action's line is written by the plugin's own `describe`, from the
 * stored input, and this module adds the plugin's name and the Connection's
 * label after it: "Merges pull request #113 · GitHub · as work".
 *
 * An entity that no longer exists is named by its id, so a describe line is
 * always written. Names and the values an answer carries are `marked` parts,
 * so a screen can set them apart; everything else is `text`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  isId,
  type ApprovalDecision,
  dispatchAnswerOperation,
  type AnswerOperationHandlers,
  type AnswerOperationInput,
  type DescribeLine,
  type DescribeLinePart,
  type OpenRequest,
  type WorkflowDefinition,
} from "@hercule/contract";
import type { AnswerPlace } from "@hercule/plugin-host";
import {
  isPluginAnswerOperation,
  type CheckedOperation,
  type PluginAnswerOperation,
} from "../../bound-actions";
import { connectionRepository } from "../../connections";
import { PluginHost } from "../../plugins";
import { projectRepository } from "../../projects";
import { sessionRepository } from "../../sessions";
import { signalRepository } from "../../signals";
import { taskRepository } from "../../tasks";
import { workflowRepository } from "../../workflows";

/** Returns a `text` part: words of the line itself. */
const buildTextPart = (value: string): DescribeLinePart => ({ kind: "text", text: value });

/** Returns a `marked` part: a name or a value the answer carries, in full. */
const buildMarkedPart = (value: string): DescribeLinePart => ({ kind: "marked", text: value });

/** Joins groups of parts into one line, with `separator` between two groups. */
const joinParts = (groups: ReadonlyArray<DescribeLine>, separator: string): DescribeLine =>
  groups.flatMap((parts, index) => (index === 0 ? parts : [buildTextPart(separator), ...parts]));

/**
 * Formats a list of labels for a task, such as `label a` or `labels a, b`.
 */
const formatLabels = (labels: ReadonlyArray<string>): string =>
  `${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}`;

/**
 * Returns `read` wrapped so that each id is read at most once. The returned
 * function keeps its results for as long as it exists, so a new one is built
 * for each `describe` call: the answers of one record usually name the same
 * entity, and a name read for one call must not go stale in the next.
 */
const readOncePerId = <A>(read: (id: string) => Effect.Effect<A, SqlError>) => {
  const results = new Map<string, A>();
  return (id: string): Effect.Effect<A, SqlError> =>
    results.has(id)
      ? Effect.succeed(results.get(id) as A)
      : Effect.tap(read(id), (result) => Effect.sync(() => results.set(id, result)));
};

/**
 * Returns the parts that describe what one of the Requests a session waits
 * on is about, found by `requestId` among `requests`, such as "the command
 * «npm test»", listing every path of a file change or read. Returns "the
 * request" when the session no longer waits on this Request, because then its
 * details are gone.
 */
const describeOpenRequest = (
  requests: ReadonlyArray<OpenRequest>,
  requestId: string,
): DescribeLine => {
  const request = requests.find((open) => open.requestId === requestId);
  if (request === undefined) return [buildTextPart("the request")];
  switch (request.kind) {
    case "command_approval":
      return [buildTextPart("the command "), buildMarkedPart(request.detail.command)];
    case "file_change_approval":
      return [buildTextPart("the change to "), ...listPaths(request.detail.paths)];
    case "file_read_approval":
      return [buildTextPart("the read of "), ...listPaths(request.detail.paths)];
    case "tool_approval":
      return [buildTextPart("the tool call "), buildMarkedPart(request.detail.toolName)];
    case "question":
      return [buildTextPart("the question")];
  }
};

/** Lists every path as its own `marked` part, separated by commas. */
const listPaths = (paths: ReadonlyArray<string>): DescribeLine =>
  joinParts(
    paths.map((path) => [buildMarkedPart(path)]),
    ", ",
  );

/**
 * Returns the describe line of one approval answer, in the words of the
 * approval card's answers (`describeApprovalAnswer` in the contract). The
 * line for `allow_always` reads "while the session keeps running", not "for
 * the rest of the session", because a resumed session is a new harness
 * process that does not keep the rule.
 */
const describeDecision = (
  decision: ApprovalDecision,
  request: DescribeLine,
  session: DescribeLinePart,
): DescribeLine => {
  switch (decision) {
    case "allow":
      return [buildTextPart("Allow "), ...request, buildTextPart(" once in session "), session];
    case "allow_always":
      return [
        buildTextPart("Allow "),
        ...request,
        buildTextPart(" and stop asking while session "),
        session,
        buildTextPart(" keeps running"),
      ];
    case "deny":
      return [
        buildTextPart("Deny "),
        ...request,
        buildTextPart(" in session "),
        session,
        buildTextPart("; the agent is told and continues"),
      ];
    case "cancel":
      return [
        buildTextPart("Deny "),
        ...request,
        buildTextPart(" and stop the turn in session "),
        session,
      ];
  }
};

/**
 * Lists what each provenance entry of a task write records, such as
 * "ref «github:issue:1», run «…»". An entry holds at least one of the three.
 */
const describeProvenance = (
  entries: NonNullable<AnswerOperationInput<"task.update">["provenance"]>,
): DescribeLine =>
  joinParts(
    entries.map((entry) =>
      joinParts(
        [
          ...(entry.ref === undefined ? [] : [[buildTextPart("ref "), buildMarkedPart(entry.ref)]]),
          ...(entry.eventId === undefined
            ? []
            : [[buildTextPart("event "), buildMarkedPart(String(entry.eventId))]]),
          ...(entry.runId === undefined
            ? []
            : [[buildTextPart("run "), buildMarkedPart(entry.runId)]]),
        ],
        ", ",
      ),
    ),
    "; ",
  );

/**
 * Lists the fields of a new task after its title, separated by commas, such
 * as "description «…», priority high, labels a, b". Every value is written in
 * full, and an empty description is left out. The caller reads the project's
 * name.
 */
const describeNewTaskFields = (
  input: AnswerOperationInput<"task.create">,
  projectName: string | undefined,
): DescribeLine =>
  joinParts(
    [
      ...(input.description === ""
        ? []
        : [[buildTextPart("description "), buildMarkedPart(input.description)]]),
      ...(input.priority === undefined ? [] : [[buildTextPart(`priority ${input.priority}`)]]),
      ...(input.labels === undefined || input.labels.length === 0
        ? []
        : [[buildTextPart(formatLabels(input.labels))]]),
      ...(projectName === undefined
        ? []
        : [[buildTextPart("in project "), buildMarkedPart(projectName)]]),
      ...(input.provenance === undefined || input.provenance.length === 0
        ? []
        : [
            [
              buildTextPart("recording where it came from: "),
              ...describeProvenance(input.provenance),
            ],
          ]),
    ],
    ", ",
  );

/**
 * Runs a plugin action's `describe` on a stored input and returns its parts,
 * or `undefined` when the action has no `describe` or it throws. The plugin's
 * code runs on every read of an open record, so a bug in it must not fail the
 * read: the caller names the action by its id instead.
 */
const runPluginDescribe = (
  describe: ((input: unknown) => ReadonlyArray<DescribeLinePart>) | undefined,
  input: unknown,
): DescribeLine | undefined => {
  if (describe === undefined) return undefined;
  try {
    return describe(input);
  } catch {
    return undefined;
  }
};

/**
 * Builds the `describe` function of the `BoundOperations` port, which reads
 * the rows of the entities each operation names, and asks the plugin host for
 * a plugin action's own line.
 */
export const buildDescribe: Effect.Effect<
  (
    operations: ReadonlyArray<CheckedOperation>,
  ) => Effect.Effect<ReadonlyArray<DescribeLine>, SqlError>,
  never,
  SqlClient.SqlClient | PluginHost
> = Effect.gen(function* () {
  const tasks = yield* taskRepository;
  const projects = yield* projectRepository;
  const workflows = yield* workflowRepository;
  const sessions = yield* sessionRepository;
  const signals = yield* signalRepository;
  const connections = yield* connectionRepository;
  const host = yield* PluginHost;

  /**
   * Builds the describer for one `describe` call, reading each entity at
   * most once however many answers name it.
   */
  const buildDescriber = () => {
    /** Returns a task's title, or its id once it is deleted. */
    const readTaskTitle = readOncePerId((id) =>
      Effect.map(tasks.live(id), Option.match({ onNone: () => id, onSome: (task) => task.title })),
    );

    /** Returns a project's name, or its id once it is deleted. */
    const readProjectName = readOncePerId((id) =>
      Effect.map(
        projects.live(id),
        Option.match({ onNone: () => id, onSome: (project) => project.name }),
      ),
    );

    /** Returns a workflow's definition, or nothing once the workflow is deleted. */
    const readWorkflowDefinition = readOncePerId(
      (id): Effect.Effect<Option.Option<WorkflowDefinition>, SqlError> =>
        workflows.readDefinition(id),
    );

    /**
     * Returns a Connection's label, or nothing when no Connection has this
     * id. The value of a Connection input is any JSON a caller wrote, so
     * anything that is not an id is not looked up.
     */
    const readConnectionLabel = readOncePerId((id) =>
      isId(id)
        ? Effect.map(
            connections.one(id),
            Option.map((connection) => connection.label),
          )
        : Effect.succeed(Option.none<string>()),
    );

    /** Returns a signal's title, or nothing when no signal has this id. */
    const readSignalTitle = readOncePerId((id) =>
      isId(id)
        ? Effect.map(
            signals.readKindAndTitle(id),
            Option.map((signal) => signal.title),
          )
        : Effect.succeed(Option.none<string>()),
    );

    /**
     * Returns a session's name as a `marked` part, and every Request the
     * session waits on, or none when the session is gone. The name is the
     * session's title, or its id once the session is gone.
     */
    const readSessionNameAndRequests = readOncePerId((id) =>
      Effect.map(sessions.one(id), (found) => ({
        markedName: buildMarkedPart(
          Option.match(found, { onNone: () => id, onSome: (session) => session.title }),
        ),
        openRequests: Option.match(found, {
          onNone: () => [],
          onSome: (session) => session.openRequests,
        }),
      })),
    );

    /**
     * Returns the parts that list the changes of a task update, separated by
     * commas, such as "status → done, add label urgent". Every changed value
     * is written in full.
     */
    const describeTaskChanges = (
      changes: Omit<AnswerOperationInput<"task.update">, "taskId">,
    ): Effect.Effect<DescribeLine, SqlError> =>
      Effect.gen(function* () {
        const described: Array<DescribeLine> = [];
        if (changes.title !== undefined) {
          described.push([buildTextPart("title → "), buildMarkedPart(changes.title)]);
        }
        if (changes.description !== undefined) {
          described.push([buildTextPart("description → "), buildMarkedPart(changes.description)]);
        }
        if (changes.status !== undefined) {
          described.push([buildTextPart(`status → ${changes.status}`)]);
        }
        if (changes.priority !== undefined) {
          described.push([buildTextPart(`priority → ${changes.priority}`)]);
        }
        if (changes.projectId === null) described.push([buildTextPart("remove from its project")]);
        if (typeof changes.projectId === "string") {
          described.push([
            buildTextPart("move to project "),
            buildMarkedPart(yield* readProjectName(changes.projectId)),
          ]);
        }
        if (changes.addLabels !== undefined && changes.addLabels.length > 0) {
          described.push([buildTextPart(`add ${formatLabels(changes.addLabels)}`)]);
        }
        if (changes.removeLabels !== undefined && changes.removeLabels.length > 0) {
          described.push([buildTextPart(`remove ${formatLabels(changes.removeLabels)}`)]);
        }
        if (changes.provenance !== undefined && changes.provenance.length > 0) {
          described.push([
            buildTextPart("record where it came from: "),
            ...describeProvenance(changes.provenance),
          ]);
        }
        return joinParts(described, ", ");
      });

    /**
     * Returns the parts that list every input of a run, each value in full,
     * such as "issue «42», repo connection «Acme GitHub»". An input the
     * workflow declares as a Connection is named by the Connection's label,
     * and one it declares as a signal by the signal's title. Any other value,
     * and an id that matches nothing, is written as JSON.
     */
    const describeRunInputs = (
      inputs: Readonly<Record<string, unknown>>,
      definition: Option.Option<WorkflowDefinition>,
    ): Effect.Effect<DescribeLine, SqlError> =>
      Effect.gen(function* () {
        const declarations = Option.match(definition, {
          onNone: () => [],
          onSome: (found) => found.inputs ?? [],
        });
        const described: Array<DescribeLine> = [];
        for (const [key, value] of Object.entries(inputs)) {
          const declaration = declarations.find((declared) => declared.name === key);
          const connectionLabel =
            declaration?.connection !== undefined && typeof value === "string"
              ? yield* readConnectionLabel(value)
              : Option.none<string>();
          const signalTitle =
            declaration?.signal !== undefined && typeof value === "string"
              ? yield* readSignalTitle(value)
              : Option.none<string>();
          described.push(
            Option.isSome(connectionLabel)
              ? [buildTextPart(`${key} connection `), buildMarkedPart(connectionLabel.value)]
              : Option.isSome(signalTitle)
                ? [buildTextPart(`${key} signal `), buildMarkedPart(signalTitle.value)]
                : [buildTextPart(`${key} `), buildMarkedPart(JSON.stringify(value))],
          );
        }
        return joinParts(described, ", ");
      });

    /**
     * Returns the line a plugin action's own `describe` writes for its stored
     * input, followed by the plugin's name and the label of the Connection it
     * acts through. When the action is gone, or its `describe` throws, the
     * line names the action by its id, so a line is always written.
     */
    const describePluginAction = (
      operation: PluginAnswerOperation,
    ): Effect.Effect<DescribeLine, SqlError> =>
      Effect.gen(function* () {
        const action = Option.getOrUndefined(yield* host.findWorkflowAction(operation.op));
        const plugin = (yield* host.loaded()).find((loaded) => loaded.id === action?.owner);
        const own = runPluginDescribe(action?.describe, operation.input);
        const connectionLabel =
          operation.connectionId === undefined
            ? undefined
            : Option.getOrElse(
                yield* readConnectionLabel(operation.connectionId),
                () => operation.connectionId!,
              );
        return [
          ...(own ?? [buildTextPart("Run "), buildMarkedPart(operation.op)]),
          ...(plugin === undefined ? [] : [buildTextPart(` · ${plugin.displayName}`)]),
          ...(connectionLabel === undefined
            ? []
            : [buildTextPart(" · as "), buildMarkedPart(connectionLabel)]),
        ];
      });

    const contractDescribers = {
      "task.create": (input) =>
        Effect.gen(function* () {
          const projectName =
            input.projectId === undefined ? undefined : yield* readProjectName(input.projectId);
          const fields = describeNewTaskFields(input, projectName);
          return [
            buildTextPart("Create task "),
            buildMarkedPart(input.title),
            ...(fields.length === 0 ? [] : [buildTextPart(" with "), ...fields]),
          ];
        }),
      "task.update": ({ taskId, ...changes }) =>
        Effect.gen(function* () {
          const title = yield* readTaskTitle(taskId);
          const described = yield* describeTaskChanges(changes);
          return [
            buildTextPart("Update task "),
            buildMarkedPart(title),
            ...(described.length === 0 ? [] : [buildTextPart(": "), ...described]),
          ];
        }),
      "run.start": ({ workflowId, inputs }) =>
        Effect.gen(function* () {
          const definition = yield* readWorkflowDefinition(workflowId);
          const described = yield* describeRunInputs(inputs ?? {}, definition);
          return [
            buildTextPart("Start a run of "),
            buildMarkedPart(
              Option.match(definition, { onNone: () => workflowId, onSome: (found) => found.name }),
            ),
            ...(described.length === 0 ? [] : [buildTextPart(" with "), ...described]),
          ];
        }),
      "session.input": ({ sessionId, text, model, options }) =>
        Effect.map(readSessionNameAndRequests(sessionId), (session) => {
          const optionEntries = Object.entries(options ?? {});
          return [
            buildTextPart("Send "),
            buildMarkedPart(text),
            buildTextPart(" to session "),
            session.markedName,
            ...(model === undefined ? [] : [buildTextPart(" on model "), buildMarkedPart(model)]),
            ...(optionEntries.length === 0
              ? []
              : [
                  buildTextPart(" with model options "),
                  ...joinParts(
                    optionEntries.map(([key, value]) => [
                      buildTextPart(`${key} `),
                      buildMarkedPart(JSON.stringify(value)),
                    ]),
                    ", ",
                  ),
                ]),
          ];
        }),
      "session.respondToApprovalRequest": ({ sessionId, requestId, decision }) =>
        Effect.map(readSessionNameAndRequests(sessionId), (session) =>
          describeDecision(
            decision,
            describeOpenRequest(session.openRequests, requestId),
            session.markedName,
          ),
        ),
    } satisfies AnswerOperationHandlers<AnswerPlace, Effect.Effect<DescribeLine, SqlError>>;

    return (operation: CheckedOperation): Effect.Effect<DescribeLine, SqlError> =>
      isPluginAnswerOperation(operation)
        ? describePluginAction(operation)
        : dispatchAnswerOperation(contractDescribers, operation);
  };

  return (operations: ReadonlyArray<CheckedOperation>) =>
    Effect.suspend(() => Effect.forEach(operations, buildDescriber()));
});
