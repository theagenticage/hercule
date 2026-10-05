/**
 * Workspace steps: the steps of a run whose work happens on this runner. An
 * action step runs a workspace action here, and an agent step runs as a turn
 * of a session here. Either way this runner saves how the step ended and
 * sends it to the controller.
 */
export { ACTION_DEADLINE, makeWorkspaceSteps, type WorkspaceSteps } from "./steps";
