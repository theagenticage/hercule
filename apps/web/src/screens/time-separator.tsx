import type { JSX } from "react";

/**
 * Renders a time separator: a stamp centred in the column, above the message
 * or turn it dates, as a messenger shows the time between messages. It is
 * centred, not aligned with the message, because it dates the exchange that
 * follows, and the replies under the owner's message belong to that exchange
 * too.
 */
export function TimeSeparator({ stamp }: { readonly stamp: string }): JSX.Element {
  return <div className="text-center font-mono text-fine text-faint tabular-nums">{stamp}</div>;
}
