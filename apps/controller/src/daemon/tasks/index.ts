/**
 * Tasks: what the tasks domain asks of the domains that depend on it. This
 * folder answers its Task Board Facts port from the sessions and runs, its
 * Linked Entities port from the stored External Entities, links the entities
 * on a Task's branches, builds the model call that writes a Task Summary, and
 * runs the loop that writes them.
 */
export { TaskBoardFactsLayer } from "./board-facts";
export { TaskDetailFactsLayer } from "./detail-facts";
export { BranchLinks, BranchLinksLayer } from "./branch-links";
export { LinkedEntitiesLayer } from "./linked-entities";
export { TaskLinkOwnersLayer } from "./link-owners";
export { makeTaskSessionObserver } from "./summary-observer";
export { runTaskSummaryLoop } from "./summary-writer";
export { TaskServicePortsLayer, TaskServiceWithPortsLayer } from "./task-service";
