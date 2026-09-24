import { Fragment, type JSX } from "react";

/**
 * The inputs a run started with, one line each: the name, and the value as
 * JSON, so a string reads with its quotes and a number without. A value stays
 * on one line, because a wrapped id breaks mid-token and no longer reads or
 * selects as one; a long value is truncated, and its tooltip shows it whole.
 */
export function RunInputsCard({
  inputs,
}: {
  readonly inputs: Readonly<Record<string, unknown>>;
}): JSX.Element {
  const entries = Object.entries(inputs);
  return (
    <div className="rounded-card border border-line-soft bg-surface px-4 py-3">
      {entries.length === 0 ? (
        <p className="text-fine text-faint">This run started with no inputs.</p>
      ) : (
        // One grid for every line, so the names take the width of the
        // longest one and every value starts at the same place.
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4 gap-y-2">
          {entries.map(([name, value]) => {
            const shown = JSON.stringify(value);
            return (
              <Fragment key={name}>
                <dt className="max-w-[120px] truncate font-mono text-fine text-muted" title={name}>
                  {name}
                </dt>
                <dd className="truncate font-mono text-fine text-ink" title={shown}>
                  {shown}
                </dd>
              </Fragment>
            );
          })}
        </dl>
      )}
    </div>
  );
}
