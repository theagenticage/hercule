/**
 * Works out Your work: for each signal, the open Tasks it is about. Your work
 * is never stored. A client reads the Tasks whose provenance refs match the
 * signals on screen, then matches them to the signals here (spec 10 §9.5).
 */
import { Schema } from "effect";
import { ExternalRef, MAX_FILTER_VALUES, type Signal, type Task } from "@hercule/contract";

/**
 * What Your work keeps of a Task: the fields it draws and matches by. A Task
 * itself can hold a 64 KB description and an unbounded provenance, and Your
 * work holds its Tasks for the life of the window.
 */
export interface YourWorkTask {
  readonly id: string;
  readonly title: string;
  readonly status: Task["status"];
  readonly updatedAt: string;
  /** The `ref` of each provenance entry that has one. */
  readonly provenanceRefs: ReadonlyArray<string>;
}

/** Builds the part of `task` that Your work keeps. */
export const buildYourWorkTask = (task: Task): YourWorkTask => ({
  id: task.id,
  title: task.title,
  status: task.status,
  updatedAt: task.updatedAt,
  provenanceRefs: task.provenance.flatMap((entry) => entry.ref ?? []),
});

/**
 * Your work: the signals that are about at least one open Task, keyed by
 * signal id. Each value holds the signal and its Tasks, most recently updated
 * first.
 */
export type YourWork = ReadonlyMap<
  string,
  { readonly signal: Signal; readonly tasks: ReadonlyArray<YourWorkTask> }
>;

const isExternalRef = Schema.is(ExternalRef);

/**
 * Returns the thread ref of a signal, or none. Only a plugin's signal has a
 * thread, and only a ref in the External Ref form can be found in a Task's
 * provenance, so a core signal, or a thread ref in another form, has none.
 */
const findThreadRef = (signal: Signal): ExternalRef | undefined =>
  signal.origin.type === "event" && isExternalRef(signal.origin.threadRef)
    ? signal.origin.threadRef
    : undefined;

/**
 * Returns the signals that have a thread ref Your work can be found by, in
 * their order. A screen selects these from the To do list, so a change to any
 * other signal, which can never be Your work, does not draw it again.
 */
export const listSignalsWithThreadRef = (signals: ReadonlyArray<Signal>): ReadonlyArray<Signal> =>
  signals.filter((signal) => findThreadRef(signal) !== undefined);

/**
 * What a read of Your work gives: the open Tasks whose provenance names a
 * thread ref of the To do signals, and the sorted thread refs the read asked
 * for. The refs let the app tell, when To do changes, whether this read still
 * covers its signals (see `isYourWorkReadOutdated`).
 */
export interface YourWorkRead {
  readonly tasks: ReadonlyArray<YourWorkTask>;
  readonly refs: ReadonlyArray<ExternalRef>;
}

/**
 * Returns the thread refs of `signals`: each ref once, sorted. Returns none
 * when no signal has a thread ref. The order does not depend on the order of
 * the signals, so two lists of signals with the same refs give equal lists.
 */
export const listYourWorkRefs = (signals: ReadonlyArray<Signal>): ReadonlyArray<ExternalRef> =>
  [...new Set(signals.flatMap((signal) => findThreadRef(signal) ?? []))].toSorted();

/**
 * The most bytes of `refs=` parameters one `task.query` request carries.
 * `task.query` is a GET, so its refs travel in the URL, and the controller
 * answers a query string of more than about 16 KB with 431. 64 refs of 512
 * characters would be about 32 KB. Half of the limit leaves room for the
 * request's other parameters.
 */
const MAX_REFS_QUERY_BYTES = 8 * 1024;

/**
 * Returns how many bytes `ref` takes in a query string: `refs=`, the encoded
 * ref and the `&` after it. The client writes its query with `URLSearchParams`,
 * which escapes more characters than `encodeURIComponent` (such as `~` and
 * `'`), so the size is measured with it too.
 */
const measureRefParameter = (ref: ExternalRef): number =>
  new URLSearchParams([["refs", ref]]).toString().length + 1;

/**
 * Splits `refs` into batches for `task.query { refs }`, in the order given. A
 * batch holds at most `MAX_FILTER_VALUES` refs, because the `refs` filter
 * refuses more, and at most `MAX_REFS_QUERY_BYTES` of parameters, because the
 * request is a GET. A ref over the byte limit by itself goes alone. Returns no
 * batches for no refs.
 */
export const batchYourWorkRefs = (
  refs: ReadonlyArray<ExternalRef>,
): ReadonlyArray<ReadonlyArray<ExternalRef>> => {
  const batches: Array<Array<ExternalRef>> = [];
  let bytes = 0;
  for (const ref of refs) {
    const size = measureRefParameter(ref);
    const batch = batches.at(-1);
    if (
      batch === undefined ||
      batch.length >= MAX_FILTER_VALUES ||
      bytes + size > MAX_REFS_QUERY_BYTES
    ) {
      batches.push([ref]);
      bytes = size;
    } else {
      batch.push(ref);
      bytes += size;
    }
  }
  return batches;
};

/**
 * Checks whether `read` was made for other thread refs than those of
 * `signals`, so the Tasks it holds may not be the ones these signals are
 * about. A read that failed has no Tasks, only the refs it was made for. A signal that arrives or goes without changing the set of refs
 * leaves the read current.
 */
export const isYourWorkReadOutdated = (
  read: Pick<YourWorkRead, "refs">,
  signals: ReadonlyArray<Signal>,
): boolean => {
  const refs = listYourWorkRefs(signals);
  return refs.length !== read.refs.length || refs.some((ref, index) => ref !== read.refs[index]);
};

/**
 * Returns Your work for `signals`: each signal's Tasks with a provenance entry
 * whose `ref` is the signal's thread ref, newest `updatedAt` first, ties
 * broken by id. A signal with no such Task has no entry, and one Task can
 * belong to several signals. A Task passed in twice counts once.
 *
 * `tasks` are the open Tasks the Your work read asked for, so the status of a
 * Task is not checked again here.
 */
export const matchYourWork = (
  signals: ReadonlyArray<Signal>,
  tasks: ReadonlyArray<YourWorkTask>,
): YourWork => {
  // A Task whose provenance names refs of two batches is read once per batch,
  // so the Tasks of a ref are keyed by id.
  const tasksByRef = new Map<string, Map<string, YourWorkTask>>();
  for (const task of tasks) {
    for (const ref of task.provenanceRefs) {
      const named = tasksByRef.get(ref) ?? new Map<string, YourWorkTask>();
      named.set(task.id, task);
      tasksByRef.set(ref, named);
    }
  }
  const yourWork = new Map<string, { signal: Signal; tasks: ReadonlyArray<YourWorkTask> }>();
  for (const signal of signals) {
    const threadRef = findThreadRef(signal);
    const named = threadRef === undefined ? undefined : tasksByRef.get(threadRef);
    if (named === undefined) continue;
    const matching = [...named.values()].toSorted(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    yourWork.set(signal.id, { signal, tasks: matching });
  }
  return yourWork;
};
