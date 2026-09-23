/**
 * The workflow editor module. The rest of the app reaches it only through
 * this file, so that its insides, and the libraries behind them, can change
 * without a change anywhere else.
 */
export { WorkflowEditor, type WorkflowEditorHandle } from "./workflow-editor";
