import { useMatch } from "@tanstack/react-router";
import type { DraftView } from "@hercule/client-core";
import { useDraftThread } from "../app/draft-thread";

/**
 * Returns the Draft Thread the new-thread screen shows, or `null` while that
 * screen is not open.
 *
 * The sidebar draws the draft as a row in the group it will join. The row
 * reads the draft as the screen does, see `useDraftThread`.
 */
export function useOpenDraft(): DraftView | null {
  const search = useMatch({ from: "/_connected/_shell/", shouldThrow: false })?.search;
  return useDraftThread(
    search === undefined
      ? null
      : { projectId: search.project ?? null, workspaceId: search.workspace ?? null },
  );
}
