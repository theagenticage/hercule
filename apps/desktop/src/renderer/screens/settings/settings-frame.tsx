import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
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
interface SettingsHeaderTitleProps {
  /**
   * The section the crumb links back to, such as the list a record belongs
   * to, and the search parameters that open it as the record left it, such
   * as the assistant whose memory the record is.
   */
  readonly parent: {
    readonly title: string;
    readonly to: SettingsSectionPath;
    readonly search?: Readonly<Record<string, string>>;
  };
  readonly title: string;
}

/** Sets the header's title, or clears it with `null`. It is the frame's state setter. */
const SettingsHeaderTitleSetter = createContext<(title: SettingsHeaderTitleProps | null) => void>(
  () => {},
);

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
 * It scrolls back to its top when `path`, the open screen's path, changes:
 * the body is one element for every section, so without that a record
 * opened from far down a long list would open as far down.
 */
export function SettingsFrame({
  title,
  path,
  list,
  children,
}: {
  readonly title: string;
  readonly path: string;
  readonly list: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [headerTitle, setHeaderTitle] = useState<SettingsHeaderTitleProps | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // A layout effect, so the new screen never paints at the old offset. It
  // runs before the sections' own effects, such as Intake scrolling to a kind.
  useLayoutEffect(() => {
    if (bodyRef.current !== null) bodyRef.current.scrollTop = 0;
  }, [path]);
  return (
    <>
      <header className="bar">
        <span className="crumb">
          Settings /
          {headerTitle !== null && (
            <>
              {" "}
              <Link
                to={headerTitle.parent.to}
                {...(headerTitle.parent.search === undefined
                  ? {}
                  : { search: headerTitle.parent.search })}
              >
                {headerTitle.parent.title}
              </Link>
              {" /"}
            </>
          )}
        </span>
        <h1 className="title">{headerTitle?.title ?? title}</h1>
        <span className="spacer" />
        <div ref={setActions} className="bar-actions" />
      </header>
      <div className="settings">
        {list}
        <div ref={bodyRef} className="set-body">
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
 * "Settings / `parent.title` /", where `parent.title` links to `parent.to`
 * with `parent.search`.
 * A section that shows one record of a list uses it, so the header names the
 * record and leads back to the list. The title is the section's state, such
 * as a name the user is editing, so it follows the edit. The header goes back
 * to the section's own title when this component unmounts. Draws nothing
 * itself.
 *
 * Only one `SettingsHeaderTitle` may be mounted at a time: two would set the
 * title in turn, and the later one would win.
 */
export function SettingsHeaderTitle({ parent, title }: SettingsHeaderTitleProps): null {
  const setHeaderTitle = useContext(SettingsHeaderTitleSetter);
  const { title: parentTitle, to, search } = parent;
  // The search object is new on every render, so the effect depends on its
  // text, and does not run again for a search that has not changed.
  const searchText = search === undefined ? undefined : JSON.stringify(search);
  // A layout effect, so the header never paints the section's own title first.
  useLayoutEffect(() => {
    const parsed =
      searchText === undefined
        ? {}
        : { search: JSON.parse(searchText) as Readonly<Record<string, string>> };
    setHeaderTitle({ parent: { title: parentTitle, to, ...parsed }, title });
    return () => {
      setHeaderTitle(null);
    };
  }, [setHeaderTitle, parentTitle, to, searchText, title]);
  return null;
}
