/**
 * Everything's pane: the open event, top to bottom as spec 17 §Everything
 * lists it. It holds no body and no payload.
 */
import { useImperativeHandle, useRef, type JSX, type Ref } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import type { Event, EventWithFacts } from "@hercule/contract";
import {
  buildHandlingLabels,
  describeEventSystem,
  describeEventTitle,
  describeHandlingCaption,
  formatMessageTime,
  readErrorMessage,
  type EventHandlingLabel,
} from "@hercule/client-core";
import { connectionsQuery, eventQuery, pluginsQuery } from "../../app/queries";
import { ExternalIcon } from "../../icons/external";
import { SourceMark } from "./source-mark";

/** What Intake's keys do in the pane, called by the screen's key handler. */
export interface EventPaneHandle {
  /** Opens the event on its system, in the default browser. Does nothing when its address is not known. */
  readonly openInSystem: () => void;
}

/**
 * Renders the pane of the event `eventId`. `listed` is the event as the list
 * holds it, with the facts its handlings are worked out from. An event the
 * list does not hold, such as one a link names that lies past the pages read,
 * is read alone: it has no facts, so its pane leaves "What came of it" out
 * rather than claim that nothing came of it.
 *
 * `shown` is false while the pane slides out. The pane is inert then: on its
 * way off screen, it takes no focus and screen readers skip it. `ref` gives
 * the screen's keys the pane's moves.
 */
export function EventPane({
  eventId,
  listed,
  timezone,
  shown,
  ref,
}: {
  readonly eventId: number;
  readonly listed: EventWithFacts | undefined;
  readonly timezone: string;
  readonly shown: boolean;
  readonly ref: Ref<EventPaneHandle>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const read = useQuery({ ...eventQuery(client, eventId), enabled: listed === undefined });
  const event = listed ?? read.data;
  return (
    <section className="asks-detail" aria-label="The open event" inert={!shown}>
      {event !== undefined ? (
        <EventDetail key={eventId} event={event} timezone={timezone} ref={ref} />
      ) : read.isError ? (
        <div className="ad">
          <p className="ad-flag" role="alert">
            {readErrorMessage(read.error)}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/** Renders an event's pane once its record is at hand. */
function EventDetail({
  event,
  timezone,
  ref,
}: {
  readonly event: Event | EventWithFacts;
  readonly timezone: string;
  readonly ref: Ref<EventPaneHandle>;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { data: connections } = useSuspenseQuery(connectionsQuery(client));
  const systemLinkRef = useRef<HTMLAnchorElement>(null);
  useImperativeHandle(ref, () => ({
    openInSystem: () => {
      systemLinkRef.current?.click();
    },
  }));

  const system = describeEventSystem(event, plugins);
  const receivedAt = formatMessageTime(new Date(event.receivedAt), timezone, new Date());
  const connection = connections.find((each) => each.id === event.connectionId);
  const labels = "signals" in event ? buildHandlingLabels(event, new Date(), timezone) : null;
  return (
    <>
      <article className="ad" tabIndex={-1}>
        <header>
          <div className="ad-kind">
            <span className="src">
              <SourceMark pluginId={system.pluginId} plugins={plugins} size={14} />
              {system.name}
            </span>
            <span>·</span>
            {/* The kind opens its row on Settings > Intake, on the Connection the event came through. */}
            <Link
              className="ad-kind-type mono"
              to="/settings/intake"
              search={{
                kind: event.kind,
                ...(event.connectionId === null ? {} : { connection: event.connectionId }),
              }}
            >
              {event.kind}
            </Link>
            <span className="spacer" />
            {event.url !== null && (
              <a
                ref={systemLinkRef}
                className="btn btn--quiet btn--sm"
                href={event.url}
                target="_blank"
                rel="noreferrer"
              >
                {`Open on ${system.name}`}
                <ExternalIcon size={13} />
              </a>
            )}
          </div>
          <h2 className={event.title === null ? "ad-title mono" : "ad-title"}>
            {describeEventTitle(event)}
          </h2>
          <p className="ad-asked">
            {event.author}
            {event.author !== null && receivedAt !== undefined && " · "}
            {receivedAt !== undefined && <time dateTime={event.receivedAt}>{receivedAt}</time>}
          </p>
        </header>
        <div className="ad-blocks">
          {labels !== null && (
            <section className="ad-came" aria-labelledby={`came-${String(event.id)}`}>
              <h3 className="ad-came-h" id={`came-${String(event.id)}`}>
                What came of it
              </h3>
              <ul className="ad-came-list">
                {labels.map((label) => (
                  <li key={label.key}>
                    <HandlingBlock label={label} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(connection !== undefined || event.refs.length > 0) && (
            <dl className="b-fields">
              {connection !== undefined && (
                <div>
                  <dt>Connection</dt>
                  <dd>{`${system.name} · ${connection.label}`}</dd>
                </div>
              )}
              {event.refs.length > 0 && (
                <div>
                  <dt>References</dt>
                  {event.refs.map((externalRef) => (
                    <dd key={externalRef} className="mono">
                      {externalRef}
                    </dd>
                  ))}
                </div>
              )}
            </dl>
          )}
        </div>
      </article>
      <div className="ad-keys" aria-hidden="true">
        <span>
          <kbd>J</kbd>
          <kbd>K</kbd> move
        </span>
        {event.url !== null && (
          <span>
            <kbd>O</kbd> open
          </span>
        )}
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </>
  );
}

/**
 * Renders one handling of an event as a block: its caption, the record it is
 * about in bold, and where that record stands. A handling that names no
 * record, "No action", draws its caption in bold. The block is a link to the
 * record when the app has a screen for it. A Task and a run have none yet, so
 * theirs are plain, and so is an Ignore Rule the user has deleted.
 */
function HandlingBlock({ label }: { readonly label: EventHandlingLabel }): JSX.Element {
  const caption = describeHandlingCaption(label.handling);
  const words =
    label.record === null ? (
      <span className="b-work-text">
        <b>{caption}</b>
      </span>
    ) : (
      <span className="b-work-text">
        <span className="b-work-label">{caption}</span>
        <b>{label.record}</b>
        {label.standing !== null && <span>{label.standing}</span>}
      </span>
    );
  const target = label.target;
  if (target?.kind === "signal") {
    return (
      <Link
        className="b-work b-work--link"
        to="/intake"
        search={{
          ...(target.view === "to-do" ? {} : { view: target.view }),
          signal: target.signalId,
        }}
      >
        {words}
      </Link>
    );
  }
  if (target?.kind === "session") {
    return (
      <Link
        className="b-work b-work--link"
        to="/threads/$sessionId"
        params={{ sessionId: target.sessionId }}
      >
        {words}
      </Link>
    );
  }
  if (target?.kind === "ignore-rule") {
    // The rule is listed in its plugin's section, which the link opens on
    // the rule's kind.
    return (
      <Link
        className="b-work b-work--link"
        to="/settings/intake"
        search={{ kind: target.signalKind }}
      >
        {words}
      </Link>
    );
  }
  return <div className="b-work">{words}</div>;
}
