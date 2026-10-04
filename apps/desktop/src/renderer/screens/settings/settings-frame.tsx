import type { JSX, ReactNode } from "react";
import "./settings.css";

/**
 * Renders Settings in the main pane (spec 17 §Settings, The frame):
 *
 * - the header, the crumb "Settings /" and `title`, the open section's name;
 * - below it, `list` (the Settings list) beside the body, whose column is at
 *   most 760px wide and is centred. The open section (`children`) fills the
 *   column.
 *
 * The body scrolls on its own, so the header and the list stay in place.
 */
export function SettingsFrame({
  title,
  list,
  children,
}: {
  readonly title: string;
  readonly list: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <>
      <header className="bar">
        <span className="crumb">Settings /</span>
        <h1 className="title">{title}</h1>
      </header>
      <div className="settings">
        {list}
        <div className="set-body">
          <div className="set-col">{children}</div>
        </div>
      </div>
    </>
  );
}
