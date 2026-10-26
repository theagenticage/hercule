/**
 * The sidebar's list: the items `buildSidebar` returns, virtualized
 * (`VirtualList`), in a `nav` landmark that scrolls. Every item kind has a
 * fixed height (`ITEM_HEIGHTS`).
 *
 * While the pointer rests on a group's row, one card beside the sidebar shows
 * the details of the group's lead and, for a group of several sessions, of
 * each session (`useThreadHover`).
 */
import { useRef, type JSX, type ReactNode } from "react";
import { VirtualList } from "../screens/virtual-list";
import {
  ITEM_HEIGHTS,
  pickFocusFallback,
  type SectionKey,
  type SidebarItem,
} from "./sidebar-items";
import {
  DoneGroupRow,
  DoneHeader,
  DraftRow,
  FewerRow,
  GroupLine,
  GroupRow,
  MoreRow,
  ProjectHeader,
  QuietLine,
  WaitingAssistantRow,
  WaitingHeader,
  WaitingRunRow,
  WaitingRunsLabel,
  WaitingThreadRow,
} from "./sidebar-rows";
import { ThreadHoverCard } from "./thread-hover-card";
import { useThreadHover } from "./use-thread-hover";

/**
 * What the list's rows call when they are pressed. Each callback must keep
 * its identity across renders, or every row that takes it draws again on
 * each render.
 *
 * - `onExpand`: a section's "more" row, with the section's key.
 * - `onCollapse`: an expanded section's "Show fewer" row, with the section's key.
 * - `onMarkDone`: a group row's Done button, with the ids of the Threads it
 *   marks.
 * - `onReopen`: a Done shelf row's Reopen button, with the ids of the
 *   Threads it reopens.
 * - `onToggleDoneShelf`: the Done shelf's heading.
 * - `onToggleGroup`: the dots button of a group's row, in a project or on the
 *   Done shelf, and the arrow keys, with the group's key and whether to
 *   unfold it (true) or fold it (false).
 * - `onShowQuiet`: an unfolded group's "n quiet" line, with the group's key.
 */
export interface SidebarListActions {
  readonly onExpand: (section: SectionKey) => void;
  readonly onCollapse: (section: SectionKey) => void;
  readonly onMarkDone: (sessionIds: readonly string[]) => void;
  readonly onReopen: (sessionIds: readonly string[]) => void;
  readonly onToggleDoneShelf: () => void;
  readonly onToggleGroup: (groupKey: string, unfold: boolean) => void;
  readonly onShowQuiet: (groupKey: string) => void;
}

/**
 * Returns the element that draws `item`. While `officeOpen` is true, the row
 * or line of a session with a colleague in the Office, the row of an
 * assistant and the row of a run's waiting session open the session or the
 * Conversation in the Office's drawer.
 */
const renderItem = (
  item: SidebarItem,
  onScreen: boolean,
  officeOpen: boolean,
  actions: SidebarListActions,
): JSX.Element => {
  switch (item.kind) {
    case "waiting-header":
      return <WaitingHeader key={item.key} item={item} />;
    case "waiting-thread-row":
      return <WaitingThreadRow key={item.key} item={item} officeOpen={officeOpen} />;
    case "waiting-assistant-row":
      return <WaitingAssistantRow key={item.key} item={item} officeOpen={officeOpen} />;
    case "waiting-runs-label":
      return <WaitingRunsLabel key={item.key} item={item} />;
    case "waiting-run-row":
      return <WaitingRunRow key={item.key} item={item} officeOpen={officeOpen} />;
    case "project-header":
      return <ProjectHeader key={item.key} item={item} />;
    case "group-row":
      return (
        <GroupRow
          key={item.key}
          item={item}
          onScreen={onScreen}
          officeOpen={officeOpen}
          onMarkDone={actions.onMarkDone}
          onToggleGroup={actions.onToggleGroup}
        />
      );
    case "group-line":
      return (
        <GroupLine
          key={item.key}
          item={item}
          onScreen={onScreen}
          officeOpen={officeOpen}
          onToggleGroup={actions.onToggleGroup}
        />
      );
    case "quiet-line":
      return (
        <QuietLine
          key={item.key}
          item={item}
          onShowQuiet={actions.onShowQuiet}
          onToggleGroup={actions.onToggleGroup}
        />
      );
    case "draft-row":
      return <DraftRow key={item.key} item={item} />;
    case "done-header":
      return <DoneHeader key={item.key} item={item} onToggle={actions.onToggleDoneShelf} />;
    case "done-group-row":
      return (
        <DoneGroupRow
          key={item.key}
          item={item}
          onScreen={onScreen}
          officeOpen={officeOpen}
          onReopen={actions.onReopen}
          onToggleGroup={actions.onToggleGroup}
        />
      );
    case "more":
      return <MoreRow key={item.key} item={item} onExpand={actions.onExpand} />;
    case "fewer":
      return <FewerRow key={item.key} item={item} onCollapse={actions.onCollapse} />;
  }
};

/** Returns the height of `item`, with the space above it, in CSS pixels. */
const computeItemHeight = (item: SidebarItem): number => item.leading + ITEM_HEIGHTS[item.kind];

/**
 * Renders the list in the `nav` landmark with the id `id` and the name
 * `label`, and `children` after its items, in the same scroll.
 *
 * - While `officeOpen` is true, the row or line of a session with a colleague
 *   in the Office, and the row of a waiting assistant, opens the session or
 *   the Conversation in the Office's drawer instead of on its own screen.
 *   Opening or leaving the Office draws every mounted row again, once.
 * - `actions` holds what the rows call when they are pressed
 *   (`SidebarListActions`).
 */
export function SidebarList({
  id,
  label,
  items,
  officeOpen,
  actions,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly items: readonly SidebarItem[];
  readonly officeOpen: boolean;
  readonly actions: SidebarListActions;
  readonly children?: ReactNode;
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  const { listHandlers, placement, details, unfolds } = useThreadHover(items, scrollRef);
  return (
    <>
      <VirtualList
        id={id}
        className="side-scroll"
        aria-label={label}
        scrollRef={scrollRef}
        items={items}
        computeItemHeight={computeItemHeight}
        renderItem={(item, _index, onScreen) => renderItem(item, onScreen, officeOpen, actions)}
        pickFocusFallback={pickFocusFallback}
        {...listHandlers}
      >
        {children}
      </VirtualList>
      <ThreadHoverCard placement={placement} details={details} unfolds={unfolds} />
    </>
  );
}
