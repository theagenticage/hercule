import { useEffect, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { EntityBlocks } from "@hercule/contract";
import { entityBlocksQuery } from "../../../app/queries";

/** How long a thing must stay current before its source is asked for its blocks, in milliseconds. */
const BLOCKS_DELAY_MS = 250;

/**
 * Reads the blocks of the thing `id` that the pane shows, once it has been
 * current for `BLOCKS_DELAY_MS` and the pane is active. The read goes to the
 * source of the thing, so walking down the list with J and K must not make one
 * for every row the focus passes.
 *
 * The delay is one trailing timer. A step to another thing, the pane hiding
 * and unmounting each cancel it and start nothing. A read that is out when the
 * user steps on is aborted through the query's signal. The result is of `id`
 * alone: no data shows for a thing whose blocks were not read yet, so the
 * blocks of one thing never show under the title of another.
 */
export const useInboxPaneBlocks = (
  client: HerculeClient,
  id: string,
  isActive: boolean,
): UseQueryResult<EntityBlocks> => {
  const [waitedId, setWaitedId] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!isActive) return undefined;
    const timer = setTimeout(() => {
      setWaitedId(id);
    }, BLOCKS_DELAY_MS);
    return () => {
      clearTimeout(timer);
      setWaitedId(undefined);
    };
  }, [id, isActive]);
  return useQuery({ ...entityBlocksQuery(client, id), enabled: isActive && waitedId === id });
};
