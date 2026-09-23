/**
 * What a workflow's page shows: the text, the graph, or both side by side. The
 * choice is a search parameter, so a reload or a shared link keeps it.
 *
 * This file imports only a type of the editor, which the build removes. The
 * route files read it before their page is loaded, and the editor loads with
 * the page.
 */
import type { SearchSchemaInput } from "@tanstack/react-router";
import type { WorkflowView } from "../../../screens/workflow-editor";

/** Each view, in the order the page's control offers them. */
export const WORKFLOW_VIEWS = [
  "yaml",
  "graph",
  "split",
] as const satisfies ReadonlyArray<WorkflowView>;

/** The view when the address names none. */
const DEFAULT_WORKFLOW_VIEW: WorkflowView = "split";

/**
 * The view that a word names. A word that is not a view names the default
 * view, so the page opens on a view and not on an error.
 */
export const readWorkflowView = (word: unknown): WorkflowView =>
  WORKFLOW_VIEWS.find((view) => view === word) ?? DEFAULT_WORKFLOW_VIEW;

/**
 * The search of a workflow's page. It always holds a view, because the
 * router keeps each search key that the validator does not answer: a word
 * that is not a view would otherwise reach the page as it was typed. A link
 * to the page may name no view. A view that the author chooses is always in
 * the address, the default view too.
 */
export const validateWorkflowViewSearch = (
  search: { readonly view?: unknown } & SearchSchemaInput,
): { readonly view: WorkflowView } => ({ view: readWorkflowView(search.view) });
