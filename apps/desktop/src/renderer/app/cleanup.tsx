/**
 * Offers the cleanup store (`cleanup-store.ts`) to the Fleet screens, which
 * draw the cleanup dialog and its progress.
 *
 * The shell loads this module with the first screen, and the store is Fleet
 * code (it imports `@hercule/client-core/cleanup`), so this module holds the
 * store's place and not the store. The Fleet screens create the store on first
 * use through `useCleanupStore` in `cleanup-hooks.ts`.
 */
import { createContext, useEffect, useState, type JSX, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { useDoneMoves } from "./done-moves";
import type { CleanupStore, CleanupStoreDependencies } from "./cleanup-store";

/** Where the shell's cleanup store goes once a Fleet screen creates it. */
export interface CleanupStoreHolder {
  readonly dependencies: CleanupStoreDependencies;
  store: CleanupStore | null;
}

export const CleanupContext = createContext<CleanupStoreHolder | null>(null);

/**
 * Offers `children` the place of the one cleanup store of the shell. It shows
 * its toasts in the same toast as the Done moves, so it sits inside
 * `DoneMovesProvider`. The store lives as long as the shell does, so a
 * cleanup goes on when the user leaves the screen that started it, and it ends
 * with the shell: nothing it was waiting for shows after a sign-out.
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
  const [holder] = useState<CleanupStoreHolder>(() => ({
    dependencies: { client, queryClient, showNotice: toasts.showNotice },
    store: null,
  }));
  useEffect(
    () => () => {
      holder.store?.dispose();
    },
    [holder],
  );
  return <CleanupContext value={holder}>{children}</CleanupContext>;
}
