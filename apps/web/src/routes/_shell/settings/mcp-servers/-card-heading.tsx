import type { JSX } from "react";

/** The heading of a card on a server's page: its name, and a count or other short note at the right. */
export function CardHeading({
  title,
  aside,
}: {
  readonly title: string;
  readonly aside?: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-label font-emph tracking-[0.1em] text-faint uppercase">{title}</span>
      {aside === undefined ? null : (
        <span className="ml-auto font-mono text-[10.5px] text-faint">{aside}</span>
      )}
    </div>
  );
}
