import type { JSX } from "react";
import { Field, Input, LaneLabel } from "@hercule/ui";
import {
  describeFeedInterval,
  describeFeedName,
  type ConnectionFeed,
  type FeedIntervalsDraft,
} from "@hercule/client-core";

/**
 * The poll interval of each feed the connection's type polls, one number
 * field per feed. An empty field polls the feed at its default, which the
 * placeholder shows. Renders nothing for a type that polls no feeds.
 *
 * The fields are not limited to each feed's minimum here. The controller
 * checks the minimum, and its errors are shown under the fields.
 */
export function PollingFields({
  idPrefix,
  feeds,
  draft,
  errors,
  onChange,
}: {
  /** Makes the input ids unique, because several connections' forms can share the page. */
  readonly idPrefix: string;
  readonly feeds: ReadonlyArray<ConnectionFeed>;
  readonly draft: FeedIntervalsDraft;
  /** The error for each feed, keyed by feed name. */
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (feed: string, seconds: string) => void;
}): JSX.Element | null {
  if (feeds.length === 0) return null;
  return (
    <>
      {/* The label's own margin is removed, because the form's gap sets the
          spacing between every other pair of lines. */}
      <div className="-mb-2.5">
        <LaneLabel>Polling</LaneLabel>
      </div>
      {feeds.map((feed) => {
        const inputId = `${idPrefix}-feed-${feed.name}`;
        return (
          <Field
            key={feed.name}
            id={inputId}
            label={describeFeedName(feed)}
            error={errors[feed.name]}
          >
            {/* The help goes above the input, so an error appears directly under the input. */}
            <p className="text-fine text-faint">{describeFeedInterval(feed)}</p>
            <div className="flex items-center gap-2">
              <Input
                id={inputId}
                className="w-[140px]"
                type="number"
                step={1}
                placeholder={String(feed.defaultIntervalSeconds)}
                value={draft[feed.name] ?? ""}
                onChange={(event) => {
                  onChange(feed.name, event.target.value);
                }}
              />
              <span className="text-meta text-muted">seconds</span>
            </div>
          </Field>
        );
      })}
    </>
  );
}
