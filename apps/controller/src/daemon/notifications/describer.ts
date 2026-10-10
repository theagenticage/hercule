/**
 * The describe line of an answer: what taking it does, written from its
 * operation with the current names of what the operation acts on, such as
 * "Start a run of Bugfix". This is the `describe` half of the notifications
 * domain's `BindableOperations` port.
 *
 * It reads the tasks, projects, workflows, sessions, Connections, Permission
 * Requests and permission profiles an operation names, and those domains depend on the notifications domain, so
 * the domain cannot read them itself. It reads their repositories rather than
 * their services: a describe line is part of reading a notification, not a
 * read of the task or session on the caller's behalf, so their grant checks do
 * not apply.
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
  type PermissionDecisionOutcome,
  dispatchBindableOperation,
  type BindableOperation,
  type BindableOperationHandlers,
  type BindableOperationInput,
  type DescribeLine,
  type DescribeLinePart,
  type OpenRequest,
  type WorkflowDefinition,
} from "@hercule/contract";
import { connectionRepository } from "../../connections";
import {
  permissionRequestRepository,
  PermissionProfiles,
  type PermissionProfile,
} from "../../permissions";
import { projectRepository } from "../../projects";
import { sessionRepository } from "../../sessions";
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
 * Formats a list of labels for a task update, such as `label a` or
 * `labels a, b`.
 */
const formatLabels = (labels: ReadonlyArray<string>): string =>
  `${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}`;

/**
 * Returns `read` wrapped so that each id is read at most once. The returned
 * function keeps its results for as long as it exists, so a new one is built
 * for each `describe` call: the answers of one decision usually name the same
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
 * Returns the describe line of one Permission Request answer, such as "Let
 * session «Fix the build» use «task.delete»".
 */
const describePermissionDecision = (
  outcome: PermissionDecisionOutcome,
  grant: DescribeLinePart,
  session: DescribeLinePart,
  profile: DescribeLinePart,
): DescribeLine => {
  switch (outcome) {
    case "session":
      return [buildTextPart("Let session "), session, buildTextPart(" use "), grant];
    case "profile":
      return [buildTextPart("Add "), grant, buildTextPart(" to profile "), profile];
    case "deny":
      return [buildTextPart("Refuse "), grant, buildTextPart(" to session "), session];
  }
};

/**
 * Lists what each provenance entry of a task update records, such as
 * "ref «github:issue:1», run «…»". An entry holds at least one of the three.
 */
const describeProvenance = (
  entries: NonNullable<BindableOperationInput<"task.update">["provenance"]>,
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
 * Builds the `describe` function of the `BindableOperations` port, which
 * reads the rows of the entities each operation names. It needs only the
 * database.
 */
export const buildDescribe: Effect.Effect<
  (
    operations: ReadonlyArray<BindableOperation>,
  ) => Effect.Effect<ReadonlyArray<DescribeLine>, SqlError>,
  never,
  SqlClient.SqlClient | PermissionProfiles
> = Effect.gen(function* () {
  const tasks = yield* taskRepository;
  const projects = yield* projectRepository;
  const workflows = yield* workflowRepository;
  const sessions = yield* sessionRepository;
  const connections = yield* connectionRepository;
  const permissionRequests = yield* permissionRequestRepository;
  const permissionProfiles = yield* PermissionProfiles;

  /**
   * Builds the describers for one `describe` call, each reading an entity at
   * most once however many answers name it.
   */
  const buildDescribers = () => {
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

    /** Returns a permission profile's name, or its id when it cannot be read. */
    const readProfileName = readOncePerId((id) =>
      Effect.map(
        // A profile whose stored grants no longer decode still has a name,
        // but this read returns none; the id names it instead.
        Effect.catchTag(permissionProfiles.getById(id), "GrantsError", () =>
          Effect.succeed(Option.none<PermissionProfile>()),
        ),
        Option.match({ onNone: () => id, onSome: (profile) => profile.name }),
      ),
    );

    /**
     * Returns the parts that name a Permission Request's grant, its session
     * and the profile the session asked under, which the `profile` answer
     * widens. A request that does not exist names its own id in place of all
     * three. A request's session row is never deleted, so a request without
     * one is a bug.
     */
    const readPermissionRequestParts = readOncePerId((id) =>
      Effect.gen(function* () {
        const found = yield* permissionRequests.read(id);
        if (Option.isNone(found)) {
          const missing = buildMarkedPart(id);
          return { grant: missing, session: missing, profile: missing };
        }
        const request = found.value;
        const session = yield* sessions.one(request.sessionId);
        if (Option.isNone(session)) {
          return yield* Effect.die(
            `the session ${request.sessionId} of a Permission Request has no row`,
          );
        }
        return {
          grant: buildMarkedPart(request.grant),
          session: buildMarkedPart(session.value.title),
          profile: buildMarkedPart(yield* readProfileName(request.profileId)),
        };
      }),
    );

    /**
     * Returns the parts that list the changes of a task update, separated by
     * commas, such as "status → done, add label urgent". Every changed value
     * is written in full.
     */
    const describeTaskChanges = (
      changes: Omit<BindableOperationInput<"task.update">, "taskId">,
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
     * workflow declares as a Connection is named by the Connection's label;
     * any other value, and a Connection id that matches no Connection, is
     * written as JSON.
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
          const label =
            declaration?.connection !== undefined && typeof value === "string"
              ? yield* readConnectionLabel(value)
              : Option.none<string>();
          described.push(
            Option.match(label, {
              onNone: () => [buildTextPart(`${key} `), buildMarkedPart(JSON.stringify(value))],
              onSome: (found) => [buildTextPart(`${key} connection `), buildMarkedPart(found)],
            }),
          );
        }
        return joinParts(described, ", ");
      });

    return {
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
      "permission.decide": ({ requestId, outcome }) =>
        Effect.map(readPermissionRequestParts(requestId), (parts) =>
          describePermissionDecision(outcome, parts.grant, parts.session, parts.profile),
        ),
    } satisfies BindableOperationHandlers<Effect.Effect<DescribeLine, SqlError>>;
  };

  return (operations: ReadonlyArray<BindableOperation>) =>
    Effect.suspend(() => {
      const describers = buildDescribers();
      return Effect.forEach(operations, (operation) =>
        dispatchBindableOperation(describers, operation),
      );
    });
});
