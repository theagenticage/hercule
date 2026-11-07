/**
 * How the Inbox screen reads the Inbox: the hook that gates the query on the
 * window being visible. The query itself, `inboxQuery`, is in `app/queries.ts`
 * with the sidebar's count, which is shell data. This read is not: nothing but
 * this screen reads it, and the shell's chunk should not carry its use.
 */
import { useQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { inboxQuery } from "../../../app/queries";
import { useWindowVisible } from "../../../app/window-visibility";

/**
 * Reads the Inbox while the window is visible. A hidden window starts no
 * read: a push that arrives meanwhile only marks the Inbox out of date, and
 * it is read once when the window shows again. The read does not run again for
 * focus or a reconnect, only for a push.
 *
 * `data` is `undefined` until the first read ends, unless the cache holds the
 * last visit's read, which then stands while the new one is on its way. The
 * route's loader starts that read without waiting for it.
 */
export const useInbox = (client: HerculeClient) => {
  const isVisible = useWindowVisible();
  return useQuery({ ...inboxQuery(client), enabled: isVisible });
};
