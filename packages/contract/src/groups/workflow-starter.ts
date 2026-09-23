/**
 * The text that a new workflow starts from. The web app opens a new workflow
 * on it, and the controller's tests check that the controller accepts it with
 * no problem. It is in the contract because the contract is the one package
 * that both of them use.
 *
 * It is a valid workflow, so the author sees a graph and no problem before
 * the first keystroke, and its comments teach the parts of a workflow. It has
 * no Agent step, because an Agent step names an Agent that the controller
 * must have. The completion keys are the keys of the editor: Ctrl+Space, and
 * Option+` on a Mac, where the system often takes Ctrl+Space.
 */
export const STARTER_WORKFLOW_SOURCE = `# A workflow says when a run starts and what the run does.
# Press Ctrl+Space (on a Mac, Option+\`) to see the keys and the values that
# fit where you type.
name: Weekday planning
description: Files a task at 09:00 on weekdays, and starts work on it.

# A start trigger starts a run each time an event of its kind arrives.
# cron.tick arrives on a schedule of five fields: minute, hour, day of the
# month, month and day of the week.
triggers:
  - id: weekdays
    kind: start
    source:
      kind: cron.tick
    schedule: "0 9 * * 1-5"

# A step calls an action, such as task.create, or gives a prompt to an
# Agent. A run starts at each step that no edge leads into.
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: Plan the day
      description: Read what came in overnight, and choose what to do first.
  - id: start_task
    kind: action
    action: task.update
    params:
      # Text in {{ }} is read when the step runs. Here it is the id of the
      # task that the step file_task created.
      taskId: "{{ steps.file_task.output.id }}"
      status: in-progress

# An edge runs the step in "to" after the step in "from" ends.
edges:
  - from: file_task
    to: start_task
`;
