import { useEffect, useState } from "react";
import type { Live } from "@hercule/client-core";

/**
 * Returns when the live connection was lost, or `null` while it is up or has
 * not been up yet. The connection is the app's one sign that the controller
 * cannot be reached, and it comes back by itself, so the time clears when it
 * does.
 *
 * The time is when this hook first saw the connection down. A screen opened
 * after the connection dropped shows its own opening time, which is the
 * closest the app knows.
 */
export const useOfflineSince = (live: Live): Date | null => {
  const [since, setSince] = useState<Date | null>(null);
  useEffect(
    () =>
      live.onStatus((status) => {
        if (status === "connected") setSince(null);
        else if (status === "disconnected") setSince((before) => before ?? new Date());
      }),
    [live],
  );
  return since;
};
