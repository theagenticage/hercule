import type { JSX, ReactNode } from "react";
import "./not-found.css";

/**
 * Renders the screen a route shows when the record it opens does not exist,
 * such as a thread or an assistant deleted since the link to it was made. It
 * fills the main pane, beside the sidebar: `headline` centred, and below it
 * `children`, such as a link to another screen, when there are any.
 */
export function NotFound({
  headline,
  children,
}: {
  readonly headline: string;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="not-found">
      <h1 className="not-found-headline">{headline}</h1>
      {children}
    </div>
  );
}
