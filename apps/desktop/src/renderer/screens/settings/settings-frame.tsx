import { createContext, useContext, useState, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./settings.css";

/** The element at the end of the header that holds the open section's actions, once it is drawn. */
const SettingsHeaderSlot = createContext<HTMLElement | null>(null);

/**
 * Renders Settings in the main pane (spec 17 §Settings, The frame):
 *
 * - the header, the crumb "Settings /" and `title`, the open section's name,
 *   and at its end the section's actions, which the section draws with
 *   `SettingsHeaderActions`;
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
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return (
    <>
      <header className="bar">
        <span className="crumb">Settings /</span>
        <h1 className="title">{title}</h1>
        <span className="spacer" />
        <div ref={setActions} className="bar-actions" />
      </header>
      <div className="settings">
        {list}
        <div className="set-body">
          <SettingsHeaderSlot.Provider value={actions}>
            <div className="set-col">{children}</div>
          </SettingsHeaderSlot.Provider>
        </div>
      </div>
    </>
  );
}

/**
 * Renders `children` at the end of the Settings header, such as the
 * Assistants section's "New assistant" button. A section draws its actions
 * where it keeps their state, and they leave the header when it closes.
 * Nothing is drawn in the first frame, before the header's slot exists.
 */
export function SettingsHeaderActions({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element | null {
  const slot = useContext(SettingsHeaderSlot);
  return slot === null ? null : createPortal(children, slot);
}
