/**
 * The view on a workflow's page: the YAML, the graph, or both side by side.
 * The view is a search parameter, so a reload or a shared link keeps it.
 *
 * This file imports only a type from the editor, and the build removes type
 * imports. The route files load this file before the page, so the editor
 * code stays out of that first load and loads with the page.
 */
import type { SearchSchemaInput } from "@tanstack/react-router";
import type { WorkflowView } from "../../../screens/workflow-editor";

/** Every view, in the order the view control shows them. */
export const WORKFLOW_VIEWS = [
  "yaml",
  "graph",
  "split",
] as const satisfies ReadonlyArray<WorkflowView>;

/** The view used when the URL has no valid `view` parameter. */
const DEFAULT_WORKFLOW_VIEW: WorkflowView = "split";

/**
 * Parses a `view` value. Returns the default view for any value that is not
 * a view, so the page opens instead of showing an error.
 */
export const parseWorkflowView = (value: unknown): WorkflowView =>
  WORKFLOW_VIEWS.find((view) => view === value) ?? DEFAULT_WORKFLOW_VIEW;

/**
 * Validates the search params of a workflow's page. The result always has a
 * `view`. If the validator left `view` out, the router would keep the raw
 * value from the URL, and an invalid view would reach the page.
 *
 * A link to the page may leave out the view. A view that the user chooses is
 * always written to the URL, even the default one.
 */
export const validateWorkflowViewSearch = (
  search: { readonly view?: unknown } & SearchSchemaInput,
): { readonly view: WorkflowView } => ({ view: parseWorkflowView(search.view) });
