/**
 * The workflow actions the GitHub plugin registers. Each acts through one
 * GitHub Connection, which the step names in its `connection` param, and the
 * host qualifies each id with the plugin's, so a step calls `issue.read` as
 * `github/issue.read`.
 */
import type { WorkflowActionContribution } from "@hercule/plugin-host";
import { issueComment, issueRead, issueUpdate } from "./issue";
import { prComment, prCreate, prMerge, prRead, prReview, prUpdate } from "./pr";

export const GITHUB_WORKFLOW_ACTIONS: ReadonlyArray<WorkflowActionContribution> = [
  issueRead,
  issueComment,
  issueUpdate,
  prRead,
  prComment,
  prReview,
  prUpdate,
  prMerge,
  prCreate,
];
