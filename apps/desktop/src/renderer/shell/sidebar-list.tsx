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
 * Returns the element that draws `item`. While `officeOpen` is true, the row
 * of a thread with a colleague in the Office, the row of an assistant and
 * the row of a run's waiting session open the thread or the Conversation in
 * the Office's drawer.
 */
const renderItem = (
  item: SidebarItem,
  onScreen: boolean,
  officeOpen: boolean,
  onExpand: (section: SectionKey) => void,
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
          secondLine={item.secondLine}
          pose={item.pose}
          end={item.end}
          createdAt={item.createdAt}
          workspaceClip={item.workspaceClip}
          workspaceKeep={item.workspaceKeep}
          placeDescription={item.placeDescription}
          unsent={item.unsent}
          onScreen={onScreen}
          officeOpen={officeOpen}
        />
      );
    case "draft-row":
      return (
        <DraftRow
          key={item.key}
          itemKey={item.key}
          leading={item.leading}
          model={item.model}
          workspaceClip={item.workspaceClip}
          workspaceKeep={item.workspaceKeep}
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
          onExpand={onExpand}
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
 * - `onExpand` is called with a section's key when its "more" row is
 *   pressed. It must keep its identity across renders, or every "more" row
 *   draws again on each render.
 */
export function SidebarList({
  id,
  label,
  items,
  officeOpen,
  onExpand,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly items: readonly SidebarItem[];
  readonly officeOpen: boolean;
  readonly onExpand: (section: SectionKey) => void;
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
        renderItem={(item, _index, onScreen) => renderItem(item, onScreen, officeOpen, onExpand)}
        pickFocusFallback={pickFocusFallback}
        {...listHandlers}
      >
        {children}
      </VirtualList>
      <ThreadHoverCard placement={placement} details={details} />
    </>
  );
}
