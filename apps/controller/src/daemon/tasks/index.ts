/**
 * Tasks: what the tasks domain asks of the domains that depend on it. This
 * folder answers its Task Board Facts port from the sessions and runs, builds
 * the model call that writes a Task Summary, and runs the loop that writes them.
 */
export { TaskBoardFactsLayer } from "./board-facts";
export { TaskDetailFactsLayer } from "./detail-facts";
export { TaskLinkOwnersLayer } from "./link-owners";
export { makeTaskSessionObserver } from "./summary-observer";
export {
  buildTaskSummaryCall,
  MAX_SUMMARY_INPUT_BYTES,
  parseSummaryAnswer,
  SUMMARY_OUTPUT_SCHEMA,
  type SummaryTexts,
} from "./summary-input";
export { runTaskSummaryLoop, SUMMARY_CONCURRENCY } from "./summary-writer";
