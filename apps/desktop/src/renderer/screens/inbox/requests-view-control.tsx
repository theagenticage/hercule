import { useId, type JSX, type ReactNode } from "react";
import {
  describeRequestsView,
  type RequestsGrouping,
  type RequestsShow,
  type RequestsSort,
} from "@hercule/client-core/inbox";
import { SlidersIcon } from "../../icons/sliders";
import { MenuHeading, MenuPick, ToolMenu } from "../desk";
import { usePopoverMenu } from "../use-popover-menu";

/** The name of the view control and of its menu. */
const VIEW_LABEL = "Show, group and sort";

/** The ways Requests can be grouped, with the words the menu shows. */
const GROUPINGS: ReadonlyArray<{ readonly id: RequestsGrouping; readonly name: string }> = [
  { id: "none", name: "None" },
  { id: "place", name: "By place" },
];

/** The orders of the rows inside a group, with the words the menu shows. */
const SORTS: ReadonlyArray<{ readonly id: RequestsSort; readonly name: string }> = [
  { id: "oldest", name: "Oldest first" },
  { id: "newest", name: "Newest first" },
];

const isShownPerson = (show: RequestsShow, name: string): boolean =>
  show.kind === "person" && show.name === name;

/** Renders one headed section of the menu: a group of rows named by its heading. */
function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): JSX.Element {
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId}>
      <MenuHeading id={headingId}>{title}</MenuHeading>
      {children}
    </div>
  );
}

/**
 * Renders the control at the end of the Requests heading: a sliders button,
 * followed by the words for what is not the default (`describeRequestsView`,
 * "Mine · By place"), cut with an ellipsis when long. It opens one menu with
 * three sections, each with one choice on:
 *
 * - Show: All, Mine, then each of `people`;
 * - Group: None, By place;
 * - Sort: Oldest first, Newest first.
 *
 * Picking a row calls the matching callback and leaves the menu open, so the
 * three can be set in one visit. Esc or a click outside closes it. The menu
 * changes no number anywhere.
 */
export function RequestsViewControl({
  show,
  grouping,
  sort,
  people,
  onShowChange,
  onGroupingChange,
  onSortChange,
}: {
  readonly show: RequestsShow;
  readonly grouping: RequestsGrouping;
  readonly sort: RequestsSort;
  /** The names of the people whose requests the Show section offers. */
  readonly people: readonly string[];
  readonly onShowChange: (show: RequestsShow) => void;
  readonly onGroupingChange: (grouping: RequestsGrouping) => void;
  readonly onSortChange: (sort: RequestsSort) => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps } = usePopoverMenu();
  const summary = describeRequestsView({ show, grouping, sort });
  return (
    <>
      <button
        {...triggerProps}
        type="button"
        className="inbox-view"
        title={VIEW_LABEL}
        aria-label={summary === undefined ? VIEW_LABEL : `${VIEW_LABEL}: ${summary}`}
      >
        <SlidersIcon size={16} />
        {summary !== undefined && <span className="inbox-view-summary">{summary}</span>}
      </button>
      <ToolMenu menuProps={menuProps} label={VIEW_LABEL} edge="button-end">
        <Section title="Show">
          <MenuPick
            itemProps={buildItemProps("show:all", { checked: show.kind === "all" })}
            kind="choice"
            name="All"
            isOn={show.kind === "all"}
            onPick={() => {
              onShowChange({ kind: "all" });
            }}
          />
          <MenuPick
            itemProps={buildItemProps("show:mine", { checked: show.kind === "mine" })}
            kind="choice"
            name="Mine"
            isOn={show.kind === "mine"}
            onPick={() => {
              onShowChange({ kind: "mine" });
            }}
          />
          {people.map((name) => (
            <MenuPick
              key={name}
              itemProps={buildItemProps(`show:person:${name}`, {
                checked: isShownPerson(show, name),
              })}
              kind="choice"
              name={name}
              isOn={isShownPerson(show, name)}
              onPick={() => {
                onShowChange({ kind: "person", name });
              }}
            />
          ))}
        </Section>
        <Section title="Group">
          {GROUPINGS.map((each) => (
            <MenuPick
              key={each.id}
              itemProps={buildItemProps(`group:${each.id}`, { checked: grouping === each.id })}
              kind="choice"
              name={each.name}
              isOn={grouping === each.id}
              onPick={() => {
                onGroupingChange(each.id);
              }}
            />
          ))}
        </Section>
        <Section title="Sort">
          {SORTS.map((each) => (
            <MenuPick
              key={each.id}
              itemProps={buildItemProps(`sort:${each.id}`, { checked: sort === each.id })}
              kind="choice"
              name={each.name}
              isOn={sort === each.id}
              onPick={() => {
                onSortChange(each.id);
              }}
            />
          ))}
        </Section>
      </ToolMenu>
    </>
  );
}
