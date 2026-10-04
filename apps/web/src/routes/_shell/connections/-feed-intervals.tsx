import type { JSX } from "react";
import { Field, FormSection, Input } from "@hercule/ui";
import {
  describeFeedInterval,
  describeFeedName,
  type ConnectionFeed,
  type FeedIntervalsDraft,
} from "@hercule/client-core";

/**
 * Renders the poll interval of each feed the connection's type polls, one
 * field per feed under a "Polling" heading. An empty field polls the feed at
 * its default, which the placeholder shows. Renders nothing for a type that
 * polls no feeds.
 *
 * Text that is not a whole number is refused before the save, under its
 * field. The fields are not limited to each feed's minimum here. The
 * controller checks the minimum, and its errors are shown under the fields.
 */
export function FeedIntervalFields({
  idPrefix,
  typeName,
  feeds,
  draft,
  errors,
  onChange,
}: {
  /** Makes the input ids unique, because several connections' forms can share the page. */
  readonly idPrefix: string;
  /** The connection type's display name, such as "GitHub", for each field's help line. */
  readonly typeName: string;
  readonly feeds: ReadonlyArray<ConnectionFeed>;
  readonly draft: FeedIntervalsDraft;
  /** The error for each feed, keyed by feed name. */
  readonly errors: Readonly<Record<string, string>>;
  readonly onChange: (feed: string, seconds: string) => void;
}): JSX.Element | null {
  if (feeds.length === 0) return null;
  return (
    <FormSection heading="Polling">
      {feeds.map((feed) => {
        const inputId = `${idPrefix}-feed-${feed.name}`;
        return (
          <Field
            key={feed.name}
            id={inputId}
            label={describeFeedName(feed)}
            error={errors[feed.name]}
          >
            {/* The help goes above the input, as on the generated config
                fields, so an error appears directly under the input. */}
            <p className="text-fine text-faint">{describeFeedInterval(feed, typeName)}</p>
            <div className="flex items-center gap-2">
              {/* A text field, not a number field: for text the browser cannot
                  read as a number, such as "abc", a number field hands over an
                  empty value, so the form could not say what is wrong. */}
              <Input
                id={inputId}
                className="w-[140px]"
                inputMode="numeric"
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
    </FormSection>
  );
}
