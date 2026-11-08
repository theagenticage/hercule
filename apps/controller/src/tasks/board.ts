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
 * A card also carries the outside things its Task links (`entityMarks`) and
 * the refs it sits under (`contextRefs`), and the board carries the records
 * of those refs (`places`, `edges`, `groupings`), so Work groups and filters
 * with no further read.
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
  MAX_CARD_CONTEXTS,
  MAX_CARD_QUESTION,
  MAX_ENTITY_MARKS,
  MAX_TRACKING_FAILURE_CAUSE,
  type EntityEdge,
  type EntityGrouping,
  type EntityMark,
  type EntityPlace,
  type FailureReason,
  type Forbidden,
  type SessionKind,
  type SessionRequest,
  type SessionStatus,
  type Unauthenticated,
  type WorkBoard,
  type WorkCard,
  type WorkStackCandidate,
  WORKING_SESSION_STATUSES,
} from "@hercule/contract";
import { requireGrant } from "../actor";
import { blockerRepository, NOT_BLOCKED, type CardBlocking } from "./blockers";
import { taskRepository, type BoardTask } from "./repository";
import { cutText } from "../text";

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
  /** Why the card is in its stage, when a fact placed it. See `describeStageCause`. */
  readonly stageCause: WorkCard["stageCause"];
  /** The refs the Task links, in the order they were linked. */
  readonly linkedRefs: ReadonlyArray<string>;
  /** One mark per kind of the Task's linked things that have a record, in the order they were linked. */
  readonly entityMarks: ReadonlyArray<EntityMark>;
  /**
   * The refs the Task links, then everything above them by `part of`, each
   * once, nearest first. A linked peer adds nothing.
   */
  readonly contextRefs: ReadonlyArray<string>;
}

/** What the board reads of the outside things its Tasks link and sit under. */
export interface BoardEntityContext {
  /** The record of each linked ref and each ref above one, once. Refs with no record are left out. */
  readonly places: ReadonlyArray<EntityPlace>;
  /** The current `part of` steps the walk up crossed. */
  readonly edges: ReadonlyArray<EntityEdge>;
  /** The groupable kinds that have a place, each with its caption. */
  readonly groupings: ReadonlyArray<EntityGrouping>;
  /** False when a limit cut the walk up, or a ref above a link has no record. */
  readonly contextComplete: boolean;
}

/** The facts of the Tasks on a board: one set for each Task, and the context all of them share. */
export interface BoardFacts {
  readonly cards: ReadonlyArray<BoardCardFacts>;
  readonly context: BoardEntityContext;
}

/** The Task a board read asks the facts of. */
export interface BoardFactsRequest {
  readonly id: string;
  readonly failedRunId: string | undefined;
  /** The fact that placed the Task's stage, when one did. */
  readonly stageCauseFactId: number | undefined;
}

export class TaskBoardFacts extends Context.Service<
  TaskBoardFacts,
  {
    /**
     * Returns the facts of each Task in `tasks`, in the same order, with a
     * Task that has no session and no run getting empty facts, and the
     * context of the things the Tasks link.
     *
     * The number of statements is fixed, whatever the number of Tasks. It
     * reads no transcript, and the run a Task shows as failed is the one
     * `failedRunId` names, never the Task's newest run. It opens no
     * transaction, so it runs on the read-only connection.
     */
    readonly readFacts: (
      tasks: ReadonlyArray<BoardFactsRequest>,
    ) => Effect.Effect<BoardFacts, SqlError>;

    /**
     * Returns the pairs of Tasks among `taskIds` that may be drawn as a stack,
     * at most `MAX_BOARD_STACK_CANDIDATES`, and whether more exist. A pair is
     * a lead Task that links a rich thing and a member Task that links a
     * compact thing with a confirmed link to it. A Task is never paired with
     * itself and a pair appears once. One statement, whatever the number of
     * Tasks. The task detail does not call it.
     */
    readonly readStackCandidates: (taskIds: ReadonlyArray<string>) => Effect.Effect<
      {
        readonly candidates: ReadonlyArray<WorkStackCandidate>;
        readonly truncated: boolean;
      },
      SqlError
    >;
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
 * - `summary`: the Task's summary, once it has one. It is only a description,
 *   so it never decides `openQuestion`, `failure` or any other fact above.
 * - `initiativeId`: copied from the Task. The card carries only the id; the
 *   screen reads the Initiatives apart.
 * - `blockedBy` and `blockedByCount`: copied from `blocking`, the Tasks that
 *   still block this one (see `blockerRepository`).
 * - `stageCause`: copied from the facts. Set only while the stage is the one
 *   a fact placed; any other write of the stage clears it.
 * - `entityMarks` and `contextRefs`: copied from the facts, cut to what a
 *   card can hold (`MAX_ENTITY_MARKS`, `MAX_CARD_CONTEXTS`).
 */
export const buildWorkCard = (
  task: BoardTask,
  facts: BoardCardFacts,
  blocking: CardBlocking,
): WorkCard => {
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
    ...(task.initiativeId === undefined ? {} : { initiativeId: task.initiativeId }),
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
    ...(task.summary === undefined ? {} : { summary: task.summary }),
    threadCount: facts.threadCount,
    ...(working === undefined ? {} : { workingSessionId: working.id }),
    createdAt: task.createdAt,
    stageChangedAt: task.stageChangedAt,
    lastActivityAt,
    ...(facts.stageCause === undefined ? {} : { stageCause: facts.stageCause }),
    entityMarks: facts.entityMarks.slice(0, MAX_ENTITY_MARKS),
    contextRefs: facts.contextRefs.slice(0, MAX_CARD_CONTEXTS),
    blockedBy: blocking.blockedBy,
    blockedByCount: blocking.blockedByCount,
  };
};

const make = Effect.gen(function* () {
  const tasks = yield* taskRepository;
  const blockers = yield* blockerRepository;
  const facts = yield* TaskBoardFacts;

  return {
    /**
     * Returns the board: a card for every live Task at a board stage, ordered
     * by project, then stage, then rank, at most `MAX_BOARD_CARDS` of them.
     * `truncated` is true when there were more. Nothing sorts by recent
     * activity, so a card stays where the user left it. A Task that shows a
     * failed run is always a card, so the sidebar's failure dot always leads
     * to one (see `TaskRepository.listBoardTasks`).
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
     * The board's `places` are cut at `MAX_BOARD_PLACES` by the read of the
     * entity records, which then reports an incomplete context. When that, or
     * a card's `MAX_CARD_CONTEXTS`, cuts anything, or the walk up was cut,
     * `contextComplete` is false.
     *
     * Each card lists the Tasks that still block it (`blockedBy`, at most
     * `MAX_CARD_BLOCKERS`, with `blockedByCount` before the cut), titles
     * included even for a blocker that is not on the board. One statement
     * reads them for every card.
     *
     * `initiativeDoneCounts` counts, for each open Initiative, its live Tasks
     * at `done`, which have no card. A client adds them to the Initiative's
     * cards to say how much has landed. A closed Initiative has no entry.
     *
     * The number of statements is fixed, whatever the number of cards.
     */
    query: (): Effect.Effect<WorkBoard, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("task.queryBoard");
        yield* requireGrant("session.query");
        yield* requireGrant("run.query");
        const { tasks: listed, truncated } = yield* tasks.listBoardTasks(MAX_BOARD_CARDS);
        const { cards, context } = yield* facts.readFacts(listed);
        const stackRead = yield* facts.readStackCandidates(listed.map((task) => task.id));
        const blocking = yield* blockers.readCardBlockers(listed.map((task) => task.id));
        return {
          cards: listed.map((task, index) =>
            buildWorkCard(task, cards[index]!, blocking.get(task.id) ?? NOT_BLOCKED),
          ),
          truncated,
          places: context.places,
          edges: context.edges,
          groupings: context.groupings,
          contextComplete:
            context.contextComplete &&
            cards.every((card) => card.contextRefs.length <= MAX_CARD_CONTEXTS),
          stackCandidates: stackRead.candidates,
          stackCandidatesTruncated: stackRead.truncated,
          initiativeDoneCounts: yield* tasks.countDoneTasksByInitiative(),
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
