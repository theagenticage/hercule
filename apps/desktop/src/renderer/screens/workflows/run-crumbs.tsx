import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { RunCrumbWorkflow } from "@hercule/client-core/run-page-rows";
import "../session/floating-header.css";
import "../thread/thread-header.css";
import "./run-crumbs.css";

/**
 * Renders the first crumb of a header that shows the place of a run: a link
 * to Workflows. A header whose run is gone draws only this crumb, so there is
 * still a way back to the workflows. Draw it inside a nav with the class
 * `workflow-crumbs`.
 */
export function WorkflowsCrumb(): JSX.Element {
  return (
    <span className="pill-crumb">
      <Link to="/workflows">Workflows</Link>
    </span>
  );
}

/**
 * Renders the crumb of the workflow a run was started from: a link to its
 * page, or, when it is gone, its name with why it has no page, and no link.
 * Draw it right after `WorkflowsCrumb`, in a nav with the class
 * `workflow-crumbs`.
 */
export function WorkflowCrumb({ workflow }: { readonly workflow: RunCrumbWorkflow }): JSX.Element {
  return (
    <span className="pill-crumb">
      {workflow.kind === "saved" ? (
        <Link
          to="/workflows/$workflowId"
          params={{ workflowId: workflow.workflowId }}
          title={workflow.name}
        >
          {workflow.name}
        </Link>
      ) : (
        <span title={`${workflow.name}, ${workflow.reason}`}>
          {workflow.name}
          <small>{workflow.reason}</small>
        </span>
      )}
    </span>
  );
}
