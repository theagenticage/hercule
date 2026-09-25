/**
 * The workflow editor module. The rest of the app imports it only through
 * this file, so its internals, and the libraries they use, can change without
 * changes anywhere else.
 *
 * Besides the editor it exports the graph drawing on its own, read-only, for
 * a run's page. That page draws the run's frozen plan with its own step cards
 * and edge styles, built from the card parts exported here, so its cards
 * match the editor's.
 */
export {
  WorkflowEditor,
  type MarkedIssue,
  type WorkflowEditorHandle,
  type WorkflowView,
} from "./workflow-editor";
export {
  CARD_PADDING,
  CardText,
  GraphView,
  measureMonoText,
  WORKFLOW_EDGE_STYLE,
  WorkflowNodeCard,
  type EdgeBadge,
  type EdgeStyle,
} from "./graph-view/graph-view";
