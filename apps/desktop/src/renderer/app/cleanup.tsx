/**
 * Offers the cleanup store (`cleanup-store.ts`) to the Fleet screens, which
 * draw the cleanup dialog and its progress.
 */
import {
  createContext,
  use,
  useState,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { useDoneMoves } from "./done-moves";
import { createCleanupStore, type CleanupProgress, type CleanupStore } from "./cleanup-store";

const CleanupContext = createContext<CleanupStore | null>(null);

/**
 * Creates the one cleanup store of the shell and offers it to `children`,
 * which read it with `useCleanupStore`. It shows its toasts in the same toast
 * as the Done moves, so it sits inside `DoneMovesProvider`. The store lives as
 * long as the shell does, so a cleanup goes on when the user leaves the screen
 * that started it.
 */
export function CleanupProvider({
  client,
  children,
}: {
  readonly client: HerculeClient;
  readonly children: ReactNode;
}): JSX.Element {
  const queryClient = useQueryClient();
  const { toasts } = useDoneMoves();
  const [store] = useState(() =>
    createCleanupStore({ client, queryClient, showNotice: toasts.showNotice }),
  );
  return <CleanupContext value={store}>{children}</CleanupContext>;
}

/** Returns the shell's cleanup store. The value keeps its identity. */
export function useCleanupStore(): CleanupStore {
  const store = use(CleanupContext);
  if (store === null) throw new Error("No CleanupProvider above this component");
  return store;
}

/** Returns the progress of the cleanup of the machine `runnerId`, or `null` for none, and draws again whenever it changes. */
export function useCleanupProgress(runnerId: string): CleanupProgress | null {
  const store = useCleanupStore();
  return useSyncExternalStore(store.subscribe, () => store.read(runnerId));
}
