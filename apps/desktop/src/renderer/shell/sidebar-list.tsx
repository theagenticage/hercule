/**
 * The sidebar's list: the items `buildSidebar` returns, virtualized
 * (`VirtualList`), in a `nav` landmark that scrolls. Every item kind has a
 * fixed height (`ITEM_HEIGHTS`).
 *
 * While the pointer rests on a thread row, one card beside the sidebar shows
 * the thread's details (`useThreadHover`).
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
  DoneHeader,
  DoneRow,
  DraftRow,
  MoreRow,
  ProjectHeader,
  ThreadRow,
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
 * - `onMarkDone`: a thread row's Done button, with the thread's session id.
 * - `onReopen`: a Done shelf row's Reopen button, with the session id.
 * - `onToggleDoneShelf`: the Done shelf's heading.
 */
export interface SidebarListActions {
  readonly onExpand: (section: SectionKey) => void;
  readonly onMarkDone: (sessionId: string) => void;
  readonly onReopen: (sessionId: string) => void;
  readonly onToggleDoneShelf: () => void;
}

/**
 * Returns the element that draws `item`. While `officeOpen` is true, the row
 * of a thread with a colleague in the Office, the row of an assistant and
 * the row of a run's waiting session open the thread or the Conversation in
 * the Office's drawer.
 */
const renderItem = (
  item: SidebarItem,
  onScreen: boolean,
  officeOpen: boolean,
  actions: SidebarListActions,
): JSX.Element => {
  switch (item.kind) {
    case "waiting-header":
      return (
        <WaitingHeader
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          count={item.count}
        />
      );
    case "waiting-thread-row":
      return (
        <WaitingThreadRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          sessionId={item.sessionId}
          title={item.title}
          question={item.question}
          officeOpen={officeOpen}
        />
      );
    case "waiting-assistant-row":
      return (
        <WaitingAssistantRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          assistantId={item.assistantId}
          name={item.name}
          question={item.question}
          officeOpen={officeOpen}
        />
      );
    case "waiting-runs-label":
      return <WaitingRunsLabel key={item.key} itemKey={item.key} leading={item.leading} />;
    case "waiting-run-row":
      return (
        <WaitingRunRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          sessionId={item.sessionId}
          title={item.title}
          question={item.question}
          officeOpen={officeOpen}
        />
      );
    case "project-header":
      return (
        <ProjectHeader
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          projectId={item.projectId}
          name={item.name}
          tint={item.tint}
          waitingCount={item.waitingCount}
        />
      );
    case "thread-row":
      return (
        <ThreadRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          sessionId={item.sessionId}
          title={item.title}
          pose={item.pose}
          status={item.status}
          receded={item.receded}
          activityAt={item.activityAt}
          placeClip={item.placeClip}
          placeKeep={item.placeKeep}
          providerId={item.providerId}
          model={item.details.model}
          placeDescription={item.placeDescription}
          unsent={item.unsent}
          onScreen={onScreen}
          officeOpen={officeOpen}
          onMarkDone={actions.onMarkDone}
        />
      );
    case "draft-row":
      return (
        <DraftRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          placeClip={item.placeClip}
          placeKeep={item.placeKeep}
        />
      );
    case "done-header":
      return (
        <DoneHeader
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          count={item.count}
          open={item.open}
          onToggle={actions.onToggleDoneShelf}
        />
      );
    case "done-row":
      return (
        <DoneRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          sessionId={item.sessionId}
          title={item.title}
          pose={item.pose}
          doneAt={item.doneAt}
          providerId={item.providerId}
          unsent={item.unsent}
          onScreen={onScreen}
          officeOpen={officeOpen}
          onReopen={actions.onReopen}
        />
      );
    case "more":
      return (
        <MoreRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          section={item.section}
          label={item.label}
          onExpand={actions.onExpand}
        />
      );
  }
};

/** Returns the height of `item`, with the space above it, in CSS pixels. */
const computeItemHeight = (item: SidebarItem): number => item.leading + ITEM_HEIGHTS[item.kind];

/**
 * Renders the list in the `nav` landmark with the id `id` and the name
 * `label`, and `children` after its items, in the same scroll.
 *
 * - While `officeOpen` is true, the row of a thread with a colleague in the
 *   Office, and the row of a waiting assistant, opens the thread or the
 *   Conversation in the Office's drawer instead of on its own screen.
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
  const { listHandlers, placement, details } = useThreadHover(items, scrollRef);
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
      <ThreadHoverCard placement={placement} details={details} />
    </>
  );
}
