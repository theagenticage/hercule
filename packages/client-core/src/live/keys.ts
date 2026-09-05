/**
 * The query keys every read is cached under, and what a live push maps to.
 *
 * A key is a plain array, so this package can own the builders without taking a
 * TanStack dependency: the web app hands what comes back here straight to its
 * query client. They live together with the mapping because they are two halves
 * of one agreement - a push names records, and the reader has to recognise the
 * keys those records are held under. Written apart, they would drift, and the
 * only symptom would be a screen that quietly stops updating.
 */
import type { MutableLiveTopic, TaskFilter } from "@hydra/contract";

/** One cache key. Opaque here; the app's query client is what reads it. */
export type LiveQueryKey = ReadonlyArray<unknown>;

/**
 * Every read the app makes, keyed. The listing builders take their narrowing
 * argument optionally: without it they are the prefix that covers every
 * narrowing of that read at once, which is what an invalidation needs.
 */
export const queryKeys = {
  setup: (): LiveQueryKey => ["setup"],
  settings: (): LiveQueryKey => ["settings"],
  tasks: (filter?: TaskFilter): LiveQueryKey =>
    filter === undefined ? ["tasks"] : ["tasks", filter],
  task: (id?: string): LiveQueryKey => (id === undefined ? ["task"] : ["task", id]),
  projects: (): LiveQueryKey => ["projects"],
  runners: (): LiveQueryKey => ["runners"],
  controller: (): LiveQueryKey => ["controller"],
  /** Keyed on the loopback endpoints it asks, because that is what it depends on. */
  localRunner: (endpoints: ReadonlyArray<string>): LiveQueryKey => ["local-runner", endpoints],
} as const;

/**
 * The keys a mutable topic's push means. Naming no id means every record of the
 * topic changed, which is what a reconnect assumes, so the answer is the two
 * prefixes rather than a list nobody has.
 */
export const queryKeysFor = (
  topic: MutableLiveTopic,
  ids: ReadonlyArray<string>,
): ReadonlyArray<LiveQueryKey> => {
  // A topic nothing reads has no key to invalidate; a topic gains a case here
  // when a screen starts reading it.
  if (topic === "task") {
    return ids.length === 0
      ? [queryKeys.tasks(), queryKeys.task()]
      : [queryKeys.tasks(), ...ids.map((id) => queryKeys.task(id))];
  }
  // The fleet is read as one listing and never a machine at a time, so which
  // runners changed narrows nothing: the listing is reread either way.
  if (topic === "runner") return [queryKeys.runners()];
  return [];
};
