/**
 * The workflows that ship with Hercule. `WorkflowService.installShipped`
 * stores each one once, and the controller daemon installs them at boot
 * (spec 10 section 2.7). Once installed, a shipped workflow is an ordinary
 * workflow: the user can edit, disable or delete it.
 *
 * Both workflows listen for `task.entityChanged`, the fact that a thing a
 * Task links changed, and move the Task's card with `task.update`. They run
 * no agent and use no workspace, so a run costs a few rows and no model call.
 */

/** A workflow that ships with Hercule: its stable key, and its YAML source. */
export interface ShippedWorkflowSource {
  /**
   * Names the workflow for good. The `shipped_workflows` table remembers the
   * key once it is installed, so a source changed later never reaches anyone
   * who has the key, and a key is never renamed to get round that.
   */
  readonly key: string;
  readonly source: string;
}

const CARD_IN_REVIEW_SOURCE = `name: Move a card to In review when its pull request opens
description: A Task linked an open pull request, so its card moves to In review. Edit or delete this as you like.
inputs:
  - name: task_id
    schema:
      type: string
    required: true
  - name: fact_id
    schema:
      type: integer
    required: true
triggers:
  - id: pull_request_open
    kind: start
    on:
      kind: task.entityChanged
      filter: event.payload.entityKind == "github/pull-request" && event.payload.lifecycle == "open"
    inputs:
      task_id: event.payload.taskId
      fact_id: event.payload.factId
    spawnBound:
      maxRuns: 200
      windowSeconds: 3600
steps:
  - id: move_card
    kind: action
    action: task.update
    params:
      taskId: "{{ inputs.task_id }}"
      stage: in-review
      stageFactId: "{{ inputs.fact_id }}"
`;

const CARD_LANDED_SOURCE = `name: Move a card to Landed when its work is finished
description: Everything linked to a Task is finished, and at least one thing completed, so its card moves to Landed. While anything linked is open, it stays. It never moves a card to Done. Edit or delete this as you like.
inputs:
  - name: task_id
    schema:
      type: string
    required: true
  - name: fact_id
    schema:
      type: integer
    required: true
triggers:
  - id: work_finished
    kind: start
    on:
      kind: task.entityChanged
      filter: event.payload.openLinks == 0 && event.payload.completedLinks > 0
    inputs:
      task_id: event.payload.taskId
      fact_id: event.payload.factId
    spawnBound:
      maxRuns: 200
      windowSeconds: 3600
steps:
  - id: move_card
    kind: action
    action: task.update
    params:
      taskId: "{{ inputs.task_id }}"
      stage: landed
      stageFactId: "{{ inputs.fact_id }}"
      onlyWhenLinkedWorkFinished: true
`;

/** Every workflow that ships with Hercule. */
export const SHIPPED_WORKFLOWS: ReadonlyArray<ShippedWorkflowSource> = [
  { key: "card-in-review", source: CARD_IN_REVIEW_SOURCE },
  { key: "card-landed", source: CARD_LANDED_SOURCE },
];
