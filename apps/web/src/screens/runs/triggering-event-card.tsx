import type { JSX } from "react";
import { formatPreciseStamp, isWebLink } from "@hercule/client-core";
import type { TriggerEvent } from "@hercule/contract";
import { INLINE_LINK } from "../actor-link";
import { JsonText } from "./json-text";

/**
 * Renders the event that started a run, in a card framed like the inputs card:
 * the event's kind, its source, when it occurred and its position in the
 * event log, with a link to the event in its own system when it has one. An
 * address that is not http or https is not linked, because a plugin or an
 * agent sets it and it could lead anywhere.
 * Below them comes the event's payload as indented JSON, because the payload
 * is what the trigger's input mapping read to make the run's inputs.
 */
export function TriggeringEventCard({
  event,
  timezone,
}: {
  readonly event: TriggerEvent;
  readonly timezone: string;
}): JSX.Element {
  return (
    <div className="rounded-card border border-line-soft bg-surface">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2 px-4 py-3">
        <dt className="text-fine text-muted">kind</dt>
        <dd className="truncate font-mono text-fine text-ink" title={event.kind}>
          {event.kind}
        </dd>
        <dt className="text-fine text-muted">source</dt>
        <dd className="truncate font-mono text-fine text-ink">{event.source}</dd>
        <dt className="text-fine text-muted">occurred</dt>
        <dd className="font-mono text-fine text-ink tabular-nums">
          <time dateTime={event.occurredAt}>
            {formatPreciseStamp(new Date(event.occurredAt), timezone) ?? event.occurredAt}
          </time>
        </dd>
        <dt className="text-fine text-muted">event</dt>
        <dd className="flex min-w-0 items-baseline gap-3 text-fine">
          <span className="font-mono text-ink tabular-nums">{String(event.id)}</span>{" "}
          {event.url === null || !isWebLink(event.url) ? null : (
            <a
              href={event.url}
              target="_blank"
              rel="noreferrer"
              title={event.url}
              className={INLINE_LINK}
            >
              Open
            </a>
          )}
        </dd>
      </dl>
      <JsonText value={event.payload} className="border-t border-line-soft px-4 py-3" />
    </div>
  );
}
