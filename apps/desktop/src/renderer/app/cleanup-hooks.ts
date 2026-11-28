/**
 * The hooks the Fleet screens read the cleanup store with. They live apart
 * from `CleanupProvider` (`cleanup.tsx`), which the shell loads with the first
 * screen, because the store is Fleet code.
 */
import { use, useSyncExternalStore } from "react";
import type { CleanupProgress } from "@hercule/client-core/cleanup-progress";
import { CleanupContext } from "./cleanup";
import { createCleanupStore, type CleanupStore } from "./cleanup-store";

/**
 * Returns the shell's cleanup store, creating it on first use. The value keeps
 * its identity. Creating it while rendering is safe: it starts nothing, and a
 * render that runs twice finds the first one's store.
 */
export function useCleanupStore(): CleanupStore {
  const holder = use(CleanupContext);
  if (holder === null) throw new Error("No CleanupProvider above this component");
  holder.store ??= createCleanupStore(holder.dependencies);
  return holder.store;
}

/** Returns the progress of the cleanup of the machine `runnerId`, or `null` for none, and draws again whenever it changes. */
export function useCleanupProgress(runnerId: string): CleanupProgress | null {
  const store = useCleanupStore();
  return useSyncExternalStore(store.subscribe, () => store.read(runnerId));
}
