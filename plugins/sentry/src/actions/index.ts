/**
 * The workflow actions the Sentry plugin registers. Each acts through one
 * Sentry Connection, which the step names in its `connection` param, and the
 * host qualifies each id with the plugin's, so a step calls `issue.resolve`
 * as `sentry/issue.resolve`.
 */
import type { WorkflowActionContribution } from "@hercule/plugin-host";
import { issueArchive, issueAssign, issueResolve } from "./issue";

export const SENTRY_WORKFLOW_ACTIONS: ReadonlyArray<WorkflowActionContribution> = [
  issueResolve,
  issueArchive,
  issueAssign,
];
