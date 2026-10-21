/**
 * Works out Your work: for each signal on To do, the open Tasks it is about.
 * The controller finds the Tasks of the open signals (`signal.queryYourWork`,
 * spec 10 §9.5); this file keeps those of the signals on the To do list a
 * client holds.
 */
import type { Signal, YourWorkTask } from "@hercule/contract";

/**
 * Your work: the signals that are about at least one open Task, keyed by
 * signal id. Each value holds the signal and its Tasks, in the order the
 * controller listed them: most recently updated first.
 */
export type YourWork = ReadonlyMap<
  string,
  { readonly signal: Signal; readonly tasks: ReadonlyArray<YourWorkTask> }
>;

/**
 * Returns Your work for `signals`: each signal's Tasks, those whose
 * `signalIds` include the signal, in the order of `tasks`. A signal with no
 * Task has no entry, and one Task can belong to several signals.
 *
 * `signals` is the To do list the client holds now. `tasks` also names open
 * signals that are snoozed, or that the user just moved off To do. Neither is
 * in `signals`, so neither shows Your work. A signal on To do shows the Tasks
 * the controller named for it, whichever read came first.
 */
export const matchYourWork = (
  signals: ReadonlyArray<Signal>,
  tasks: ReadonlyArray<YourWorkTask>,
): YourWork => {
  const tasksBySignalId = new Map<string, Array<YourWorkTask>>();
  for (const task of tasks) {
    for (const signalId of task.signalIds) {
      const named = tasksBySignalId.get(signalId) ?? [];
      named.push(task);
      tasksBySignalId.set(signalId, named);
    }
  }
  const yourWork = new Map<string, { signal: Signal; tasks: ReadonlyArray<YourWorkTask> }>();
  for (const signal of signals) {
    const named = tasksBySignalId.get(signal.id);
    if (named !== undefined) yourWork.set(signal.id, { signal, tasks: named });
  }
  return yourWork;
};
