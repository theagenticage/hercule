/**
 * The YAML source a new workflow starts from. The web app opens the editor on
 * it for a new workflow, and the controller's tests check that it validates
 * with no errors or warnings. It lives in the contract because the contract is
 * the one package that both of them import.
 *
 * The source is a valid workflow, so the author sees a graph and no errors
 * before typing anything, and its comments explain the parts of a workflow.
 * It has no Agent step, because an Agent step must refer to an Agent that exists
 * on the controller. The completion shortcuts are the editor's: Ctrl+Space,
 * and Option+` on a Mac, where the system often takes Ctrl+Space.
 */
export const STARTER_WORKFLOW_SOURCE = `# A workflow defines when a run starts and what the run does.
# Press Ctrl+Space (Option+\` on a Mac) to see the keys and values you can
# use where you are typing.
name: Weekday planning
description: Files a task at 09:00 on weekdays, and starts work on it.

# A start trigger starts a run each time an event of a kind arrives, or each
# time its schedule comes due. A schedule has five fields: minute, hour, day
# of the month, month and day of the week.
triggers:
  - id: weekdays
    kind: start
    on:
      schedule: "0 9 * * 1-5"

# A step either calls an action, such as task.create, or gives a prompt to
# an Agent. A run starts at each step that no edge leads into.
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
      # Text in {{ }} is evaluated when the step runs. Here it gives the id
      # of the task that the file_task step created.
      taskId: "{{ steps.file_task.output.id }}"
      status: in-progress

# An edge runs the "to" step after the "from" step ends.
edges:
  - from: file_task
    to: start_task
`;
