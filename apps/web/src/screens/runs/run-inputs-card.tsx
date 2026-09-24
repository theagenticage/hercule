import type { JSX } from "react";

/**
 * The inputs a run started with, one line each: the name, and the value as
 * JSON, so a string reads with its quotes and a number without. A long value
 * wraps to at most three lines, and its tooltip shows the whole value.
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
        <dl className="flex flex-col gap-2">
          {entries.map(([name, value]) => {
            const shown = JSON.stringify(value);
            return (
              <div key={name} className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-3">
                <dt className="truncate font-mono text-fine text-muted" title={name}>
                  {name}
                </dt>
                <dd className="line-clamp-3 font-mono text-fine break-all text-ink" title={shown}>
                  {shown}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </div>
  );
}
