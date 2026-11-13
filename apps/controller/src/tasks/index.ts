/** Tasks: the units of human intent the API reads and writes. */
export {
  NEW_THREAD_TASK_STAGE,
  ONLY_THE_USER_TAKES_ON_WORK,
  TaskService,
  TaskServiceLayer,
  type CreatedTaskUndo,
  type TakeOnUndo,
  type EntityHandoffReversal,
  type EntityHandoffUndoState,
  type FailureRestoration,
  type FailureRestoreRefusal,
  type QueryInput,
  type TaskPage,
  type TaskUndoRefusal,
  type UpdateInput,
} from "./service";
export type { TakeOnRecord } from "./take-on-records";
export { groupByTask } from "./lists";
export type { EntityLinkPair } from "./entity-facts";
export {
  LIVE_TASK_LINKS_SQL,
  buildLiveTaskLinksSql,
  JOINABLE_TASK_SQL,
  taskRepository,
  type BoardTask,
  type NewTask,
} from "./repository";
export {
  SUMMARY_CONCURRENCY,
  SUMMARY_MIN_INTERVAL_SECONDS,
  SUMMARY_QUIET_SECONDS,
  TaskSummaries,
  TaskSummariesLayer,
  type SummaryDescriber,
  type SummaryText,
} from "./summaries";
export { TaskLinkOwners } from "./link-owners";
export { entityFactRepository, type EntityFact } from "./entity-facts";
export { describeStageCause, type StageCauseThing } from "./stage-cause";
export { LinkedEntities, type LinkedEntityState } from "./linked-entities";
export { makeSummaryDirtyMarker } from "./summary-dirty";
export { makeSummaryWake, TaskSummaryWake, type SummaryWake } from "./summary-wake";
export {
  buildWorkCard,
  TaskBoard,
  TaskBoardFacts,
  TaskBoardLayer,
  type BoardCardFacts,
  type BoardEntityContext,
  type BoardFacts,
  type BoardFactsRequest,
  type BoardFailureFact,
  type BoardSessionFact,
} from "./board";
export { TaskDetailFacts, TaskDetails, TaskDetailsLayer } from "./detail";
export {
  TaskTracking,
  TaskTrackingLayer,
  TaskTrackingRuns,
  type HandoffRun,
  type LegRuns,
  type TrackedRunHistory,
  type TrackedRuns,
} from "./tracking";
