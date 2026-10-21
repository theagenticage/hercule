/**
 * Works out Your work: for each signal, the open Tasks it is about. Your work
 * is never stored. A client reads the Tasks whose provenance refs match the
 * signals on screen, then matches them to the signals here (spec 10 §9.5).
 */
import { Schema } from "effect";
import { ExternalRef, MAX_FILTER_VALUES, type Signal, type Task } from "@hercule/contract";

/** The open Tasks of each signal, most recently updated first, keyed by signal id. */
export type YourWork = ReadonlyMap<string, ReadonlyArray<Task>>;

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
  readonly tasks: ReadonlyArray<Task>;
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
 * Returns the thread refs of `signals` in batches for `task.query { refs }`,
 * in the order `listYourWorkRefs` gives. A batch holds at most
 * `MAX_FILTER_VALUES` refs, because the `refs` filter refuses more. Returns no
 * batches when no signal has a thread ref.
 */
export const batchYourWorkRefs = (
  signals: ReadonlyArray<Signal>,
): ReadonlyArray<ReadonlyArray<ExternalRef>> => {
  const refs = listYourWorkRefs(signals);
  const batches: Array<ReadonlyArray<ExternalRef>> = [];
  for (let start = 0; start < refs.length; start += MAX_FILTER_VALUES) {
    batches.push(refs.slice(start, start + MAX_FILTER_VALUES));
  }
  return batches;
};

/**
 * Checks whether `read` was made for other thread refs than those of
 * `signals`, so the Tasks it holds may not be the ones these signals are
 * about. Returns false when there is no `read` yet, because a read that has not
 * finished will be made for the signals it finds.
 */
export const isYourWorkReadOutdated = (
  read: YourWorkRead | undefined,
  signals: ReadonlyArray<Signal>,
): boolean => {
  if (read === undefined) return false;
  const refs = listYourWorkRefs(signals);
  return refs.length !== read.refs.length || refs.some((ref, index) => ref !== read.refs[index]);
};

/**
 * Returns Your work for `signals`: each signal's open Tasks (status `open` or
 * `in-progress`) with a provenance entry whose `ref` is the signal's thread
 * ref, newest `updatedAt` first, ties broken by id. A signal with no such Task
 * has no entry, and one Task can belong to several signals. A Task passed in
 * twice counts once. A done or cancelled Task never matches, even when passed
 * in, so this is the one place that holds the rule.
 */
export const matchYourWork = (
  signals: ReadonlyArray<Signal>,
  tasks: ReadonlyArray<Task>,
): YourWork => {
  // A Task whose provenance names refs of two batches is read once per batch.
  const openTasks = [...new Map(tasks.map((task) => [task.id, task])).values()].filter(
    (task) => task.status === "open" || task.status === "in-progress",
  );
  const yourWork = new Map<string, ReadonlyArray<Task>>();
  for (const signal of signals) {
    const threadRef = findThreadRef(signal);
    if (threadRef === undefined) continue;
    const matching = openTasks
      .filter((task) => task.provenance.some((entry) => entry.ref === threadRef))
      .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    if (matching.length > 0) yourWork.set(signal.id, matching);
  }
  return yourWork;
};
