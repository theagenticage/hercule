import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import type { SettingsSectionPath } from "../../app/last-settings-section";
import "./settings.css";

/** The element at the end of the header that holds the open section's actions, once it is drawn. */
const SettingsHeaderSlot = createContext<HTMLElement | null>(null);

/** The crumb and title a section draws in the header in place of the frame's own. */
interface HeaderTitle {
  /** The section the crumb links back to, such as the list a record belongs to. */
  readonly parent: { readonly title: string; readonly to: SettingsSectionPath };
  readonly title: string;
}

/** Sets the header's title, or clears it with `null`. It is the frame's state setter. */
const SettingsHeaderTitleSetter = createContext<(title: HeaderTitle | null) => void>(() => {});

/**
 * Renders Settings in the main pane (spec 17 §Settings, The frame):
 *
 * - the header, the crumb "Settings /" and `title`, the open section's name,
 *   and at its end the section's actions, which the section draws with
 *   `SettingsHeaderActions`. A section that shows one record draws its own
 *   crumb and title with `SettingsHeaderTitle`;
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
  const [headerTitle, setHeaderTitle] = useState<HeaderTitle | null>(null);
  return (
    <>
      <header className="bar">
        <span className="crumb">
          Settings /
          {headerTitle !== null && (
            <>
              {" "}
              <Link to={headerTitle.parent.to}>{headerTitle.parent.title}</Link> /
            </>
          )}
        </span>
        <h1 className="title">{headerTitle?.title ?? title}</h1>
        <span className="spacer" />
        <div ref={setActions} className="bar-actions" />
      </header>
      <div className="settings">
        {list}
        <div className="set-body">
          <SettingsHeaderSlot.Provider value={actions}>
            <SettingsHeaderTitleSetter.Provider value={setHeaderTitle}>
              <div className="set-col">{children}</div>
            </SettingsHeaderTitleSetter.Provider>
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

/**
 * Replaces the Settings header's title with `title`, and its crumb with
 * "Settings / `parent.title` /", where `parent.title` links to `parent.to`.
 * A section that shows one record of a list uses it, so the header names the
 * record and leads back to the list. The title is the section's state, such
 * as a name the user is editing, so it follows the edit. It returns to the
 * section's own title when the component unmounts. Draws nothing itself.
 */
export function SettingsHeaderTitle({ parent, title }: HeaderTitle): null {
  const setHeaderTitle = useContext(SettingsHeaderTitleSetter);
  const { title: parentTitle, to } = parent;
  // A layout effect, so the header never paints the section's own title first.
  useLayoutEffect(() => {
    setHeaderTitle({ parent: { title: parentTitle, to }, title });
    return () => {
      setHeaderTitle(null);
    };
  }, [setHeaderTitle, parentTitle, to, title]);
  return null;
}
