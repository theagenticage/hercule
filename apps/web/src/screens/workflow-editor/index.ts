/**
 * The workflow editor module. The rest of the app imports it only through
 * this file, so its internals, and the libraries they use, can change without
 * changes anywhere else.
 *
 * Besides the editor it exports the graph on its own, read-only, for a run's
 * page, which draws the run's frozen plan with each step's progress on it.
 */
export {
  WorkflowEditor,
  type MarkedIssue,
  type WorkflowEditorHandle,
  type WorkflowView,
} from "./workflow-editor";
export { GraphView } from "./graph-view/graph-view";
