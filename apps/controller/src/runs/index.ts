/**
 * Runs: the rows that record each run of a workflow's steps, and the run
 * engine that starts runs, executes them and cancels them. The engine runs
 * every kind of step: actions, workspace actions, agent steps, and the
 * signals a run's signal triggers record when an event matches them.
 *
 * Where a run's execution is carried out is not this domain's decision: it
 * hands the execution to the Run Executor, and a workspace step, an agent
 * step's session included, to Workspace Steps, both of which the controller
 * daemon implements. The run's session observer fails an agent step whose
 * session ends before it answers the step's prompt.
 */
export { RunExecutor } from "./executor";
export { runRepository } from "./repository";
export { resumeUnfinishedRuns, RunService, RunServiceLayer } from "./service";
export { makeRunSessionObserver } from "./session-observer";
export { isUnfinished } from "./step-records";
export { RunWorkspaceStepActivityLayer } from "./workspace-step-activity";
export {
  StepSessionRefused,
  WorkspaceSteps,
  type ActionStepToStart,
  type AgentStep,
  type AgentStepResultToRequest,
  type OpenedStepSession,
  type StepSessionToOpen,
  type WorkspaceStepToStart,
  type WorkspaceStepToSettle,
} from "./workspace-steps";
