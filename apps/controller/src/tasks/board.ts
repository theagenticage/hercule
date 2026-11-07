/**
 * The Work board's read: `task.queryBoard` returns every unfinished Task as a
 * card, with the three facts a card shows (spec 09, spec 11).
 *
 * - `openQuestion`: a Thread of the Task has a question open. This is the
 *   only thing that means "wants you".
 * - `failure`: the Task shows a failed run (`tasks.failed_run_id`).
 * - `workingSessionId`: a session of the Task is live.
 *
 * The three are independent. A card can have all of them, and none hides
 * another. They are worked out here, from rows, so no client joins them
 * again.
 *
 * The Task rows are this domain's. The sessions and runs of each Task belong
 * to domains that depend on this one, so this domain declares what it needs
 * as the `TaskBoardFacts` port and the controller daemon implements it
 * (ADR 0033), as it does for `TaskTrackingRuns`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  describeFailureCause,
  MAX_BOARD_CARDS,
  MAX_CARD_QUESTION,
  MAX_TRACKING_FAILURE_CAUSE,
  type FailureReason,
  type Forbidden,
  type SessionKind,
  type SessionRequest,
  type SessionStatus,
  type Unauthenticated,
  type WorkBoard,
  type WorkCard,
  WORKING_SESSION_STATUSES,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { taskRepository, type BoardTask } from "./repository";
import { cutText } from "./tracking-output";

/** A session of a Task that the board looks into. */
export interface BoardSessionFact {
  readonly id: string;
  readonly kind: SessionKind;
  readonly status: SessionStatus;
  readonly createdAt: string;
  /** The Requests the session has open, oldest first. */
  readonly openRequests: ReadonlyArray<SessionRequest>;
}

/** Why the run a Task shows as failed failed. */
export interface BoardFailureFact {
  readonly runId: string;
  /** The name of the run's workflow as it was when the run started. */
  readonly workflowName: string;
  readonly reason: FailureReason;
  /** What went wrong, when the run says so. */
  readonly message: string | undefined;
}

/**
 * What the board reads of the sessions and runs of one Task. It holds no
 * transcript and no history: the sessions are only the ones the board looks
 * into, and the rest is counts and times.
 */
export interface BoardCardFacts {
  /**
   * The sessions that can decide a fact of the card: the live ones, the ones
   * with an open Request, the newest Thread, and the newest session of any
   * kind. Other sessions are left out.
   */
  readonly sessions: ReadonlyArray<BoardSessionFact>;
  /** How many Threads the Task has, live or not. */
  readonly threadCount: number;
  /** When a session of the Task last ended a turn, if one did. */
  readonly lastTurnEndedAt: string | undefined;
  /** When a run of the Task last ended, if one did. */
  readonly lastRunEndedAt: string | undefined;
  /** The failure of the run `tasks.failed_run_id` names, when the Task has one. */
  readonly failure: BoardFailureFact | undefined;
}

/** The Task a board read asks the facts of. */
export interface BoardFactsRequest {
  readonly id: string;
  readonly failedRunId: string | undefined;
}

export class TaskBoardFacts extends Context.Service<
  TaskBoardFacts,
  {
    /**
     * Returns the facts of each Task in `tasks`, in the same order, with a
     * Task that has no session and no run getting empty facts.
     *
     * The number of statements is fixed, whatever the number of Tasks. It
     * reads no transcript, and the run a Task shows as failed is the one
     * `failedRunId` names, never the Task's newest run. It opens no
     * transaction, so it runs on the read-only connection.
     */
    readonly readFacts: (
      tasks: ReadonlyArray<BoardFactsRequest>,
    ) => Effect.Effect<ReadonlyArray<BoardCardFacts>, SqlError>;
  }
>()("hercule/controller/tasks/TaskBoardFacts") {}

/** Orders sessions by when they were opened, then by id. Timestamps and ids sort as text. */
const compareOpenedFirst = (left: BoardSessionFact, right: BoardSessionFact): number => {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

/**
 * Returns the question a Thread has open, or `undefined` when it has none.
 * An approval is not a question, and neither is a Request of any other kind.
 * With several questions open, the first of the Thread's Requests wins.
 */
const findOpenQuestion = (
  session: BoardSessionFact,
): { readonly requestId: string; readonly text: string } | undefined => {
  for (const request of session.openRequests) {
    if (request.kind === "question") {
      return {
        requestId: request.requestId,
        text: cutText(request.detail.questions[0].question, MAX_CARD_QUESTION),
      };
    }
  }
  return undefined;
};

/**
 * Returns the card of a Task from the Task's row and its facts. This is the
 * one place that decides what a card shows.
 *
 * - `openQuestion`: a session of kind `thread` has an open Request of kind
 *   `question`, asked by its own agent or by a subagent inside it, parked or
 *   async. With several Threads, the one opened first wins. An approval, a
 *   question in a session of another kind, and a Task with no open Request
 *   leave it unset.
 * - `failure`: set when the Task shows a failed run, beside everything else.
 * - `workingSessionId`: the newest live session of any kind.
 * - `openSessionId`: the Thread with the open question, else the newest
 *   Thread, else the newest session of any kind. It is for navigation only.
 * - `lastActivityAt`: the latest of the Task's creation, the last time a
 *   session of it ended a turn and the last time a run of it ended.
 */
export const buildWorkCard = (task: BoardTask, facts: BoardCardFacts): WorkCard => {
  const threads = facts.sessions
    .filter((session) => session.kind === "thread")
    .toSorted(compareOpenedFirst);
  const asked = threads
    .flatMap((thread) => {
      const question = findOpenQuestion(thread);
      return question === undefined ? [] : [{ sessionId: thread.id, ...question }];
    })
    .at(0);
  const working = facts.sessions
    .filter((session) => WORKING_SESSION_STATUSES.includes(session.status))
    .toSorted(compareOpenedFirst)
    .at(-1);
  const openSessionId =
    asked?.sessionId ??
    threads.at(-1)?.id ??
    facts.sessions.toSorted(compareOpenedFirst).at(-1)?.id;
  const lastActivityAt = [task.createdAt, facts.lastTurnEndedAt, facts.lastRunEndedAt]
    .filter((time) => time !== undefined)
    .reduce((latest, time) => (time > latest ? time : latest));
  return {
    id: task.id,
    title: task.title,
    stage: task.stage,
    priority: task.priority,
    ...(task.projectId === undefined ? {} : { projectId: task.projectId }),
    boardRank: task.boardRank,
    ...(asked === undefined ? {} : { openQuestion: asked }),
    ...(facts.failure === undefined
      ? {}
      : {
          failure: {
            runId: facts.failure.runId,
            workflowName: facts.failure.workflowName,
            cause: cutText(
              describeFailureCause({
                reason: facts.failure.reason,
                message: facts.failure.message,
              }),
              MAX_TRACKING_FAILURE_CAUSE,
            ),
          },
        }),
    ...(openSessionId === undefined ? {} : { openSessionId }),
    threadCount: facts.threadCount,
    ...(working === undefined ? {} : { workingSessionId: working.id }),
    createdAt: task.createdAt,
    stageChangedAt: task.stageChangedAt,
    lastActivityAt,
  };
};

const make = Effect.gen(function* () {
  const tasks = yield* taskRepository;
  const facts = yield* TaskBoardFacts;

  return {
    /**
     * Returns the board: a card for every live Task at a board stage, ordered
     * by project, then stage, then rank, at most `MAX_BOARD_CARDS` of them.
     * `truncated` is true when there were more. Nothing sorts by recent
     * activity, so a card stays where the user left it.
     *
     * The caller needs `task.read`, `session.read` and `run.read`: a card
     * shows a Thread's question and a run's failure, which `session.query`
     * and `run.query` guard. A caller without all three gets `Forbidden`, not
     * a thinner board. Each is checked before anything is read.
     *
     * It opens no transaction, so every statement runs on the read-only
     * connection and never waits for a writer. A Task may change between two
     * statements, and the push that change makes brings the next read.
     *
     * The number of statements is fixed, whatever the number of cards.
     */
    query: (): Effect.Effect<WorkBoard, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.queryBoard");
        yield* requireGrant("session.query");
        yield* requireGrant("run.query");
        const read = yield* tasks.listBoardTasks(MAX_BOARD_CARDS);
        const listed = read.slice(0, MAX_BOARD_CARDS);
        const cardFacts = yield* facts.readFacts(listed);
        return {
          cards: listed.map((task, index) => buildWorkCard(task, cardFacts[index]!)),
          truncated: read.length > MAX_BOARD_CARDS,
        };
      }),
  };
});

/** The Work board's read. */
export class TaskBoard extends Context.Service<TaskBoard, Effect.Success<typeof make>>()(
  "hercule/controller/tasks/TaskBoard",
) {}

export const TaskBoardLayer: Layer.Layer<TaskBoard, never, SqlClient.SqlClient | TaskBoardFacts> =
  Layer.effect(TaskBoard)(make);
