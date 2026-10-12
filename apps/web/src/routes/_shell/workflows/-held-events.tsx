import type { JSX } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import {
  describeHeldEvents,
  resolveDisplayTimezone,
  type HerculeClient,
  type TriggerReading,
} from "@hercule/client-core";
import { cn } from "@hercule/ui";
import { heldEventsQuery, settingsQuery } from "../../../app/queries";

/**
 * Renders the events a start trigger holds, below its row: how many it holds
 * and what happens to them next. When `isListed` is true, which it is while
 * the trigger is paused, it also lists the oldest few, each with its title,
 * author and received time, and counts the rest.
 *
 * The list is read with `useQuery`, not `useSuspenseQuery`, because a trigger
 * can start holding events while the page is open: a suspended read here
 * would hide the page until the list arrives. The route's loader reads the
 * list of every trigger that holds events when the page opens, so the list
 * is there from the first render.
 */
export function HeldEvents({
  client,
  workflowId,
  triggerId,
  heldCount,
  held,
  isListed,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string;
  readonly triggerId: string;
  readonly heldCount: number;
  readonly held: NonNullable<TriggerReading["held"]>;
  readonly isListed: boolean;
}): JSX.Element {
  const timezone = resolveDisplayTimezone(
    useSuspenseQuery(settingsQuery(client)).data.user.timezone,
  );
  const events = useQuery({
    ...heldEventsQuery(client, workflowId, triggerId),
    enabled: isListed,
  }).data?.items;
  const list =
    !isListed || events === undefined ? undefined : describeHeldEvents(events, heldCount, timezone);

  // The `{" "}` spaces are for screen readers. Flex layout adds no space
  // between items, so without them the texts run together.
  return (
    <div className="flex flex-col gap-0.5 pl-6 text-fine text-muted">
      <p>
        <span className="font-mono text-ink tabular-nums">{held.countText}</span>
        {` · ${held.nextText}`}
      </p>
      {list === undefined ? null : (
        <ul aria-label="Held events" className="flex flex-col gap-0.5">
          {list.rows.map((row) => (
            <li key={row.id} className="flex min-w-0 gap-2">
              {/* An event with no title is named by its kind, set in mono
                  like every other event kind on the page. */}
              <span
                title={row.title}
                className={cn("min-w-0 truncate text-ink", row.isKindTitle && "font-mono")}
              >
                {row.title}
              </span>{" "}
              {row.author === undefined ? null : (
                <span className="shrink-0 text-faint">{row.author}</span>
              )}{" "}
              <span className="shrink-0 font-mono text-faint tabular-nums">{row.receivedText}</span>
            </li>
          ))}
          {list.moreText === undefined ? null : <li>{list.moreText}</li>}
        </ul>
      )}
    </div>
  );
}
