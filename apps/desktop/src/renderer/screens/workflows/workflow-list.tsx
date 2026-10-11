/**
 * The workflow list as a table: the column heads in a sticky band as tall
 * as the floating header, then each group's heading and its rows,
 * virtualized (spec 17 §Workflows, "The list").
 */
import { useRef, type JSX } from "react";
import {
  pickWorkflowFocusFallback,
  type WorkflowListItem,
} from "@hercule/client-core/workflow-rows";
import { useShowsClassicScrollbar } from "../session/classic-scrollbar";
import { VirtualList } from "../virtual-list";
import {
  GROUP_HEADING_HEIGHT,
  WORKFLOW_ROW_HEIGHT,
  WorkflowGroupHeading,
  WorkflowTableHeads,
  WorkflowTableRow,
} from "./workflow-list-rows";
import "./workflow-list.css";

/**
 * The band above the rows: the floating header's 56px, which no row scrolls
 * into view under, then the 32px column heads.
 */
const TABLE_HEAD = { height: 88, content: <WorkflowTableHeads /> };

/**
 * Returns the space above the group heading at `index`, in CSS pixels. The
 * first heading sits 14px under the column heads, and every other one 22px
 * under the row before it.
 */
const computeHeadingLeading = (index: number): number => (index === 0 ? 14 : 22);

/** Returns the height of an item with the space above it, in CSS pixels. */
const computeItemHeight = (item: WorkflowListItem, index: number): number =>
  item.kind === "group-header"
    ? computeHeadingLeading(index) + GROUP_HEADING_HEIGHT
    : WORKFLOW_ROW_HEIGHT;

/** Returns the element that draws `item`, with its times shown in `timezone`. */
const renderItem = (
  item: WorkflowListItem,
  index: number,
  onScreen: boolean,
  timezone: string,
): JSX.Element =>
  item.kind === "group-header" ? (
    <WorkflowGroupHeading
      key={item.key}
      itemKey={item.key}
      leading={computeHeadingLeading(index)}
      title={item.title}
      count={item.count}
      isNeedsYou={item.group === "needsYou"}
    />
  ) : (
    <WorkflowTableRow
      key={item.key}
      itemKey={item.key}
      workflowId={item.row.id}
      name={item.row.name}
      mark={item.row.mark}
      isOff={item.row.isOff}
      startsOnTexts={item.row.startsOnTexts}
      startsOnFiresOn={item.row.startsOnFiresOn}
      startsOnIsCode={item.row.startsOnIsCode}
      strip={item.row.strip}
      successText={item.row.successText}
      statusText={item.row.statusText}
      statusTone={item.row.statusTone}
      lastRunAt={item.row.lastRunAt}
      nextText={item.row.nextText}
      nextFireAt={item.row.nextFireAt}
      timezone={timezone}
      onScreen={onScreen}
    />
  );

/**
 * Renders `items` as the table, with its times shown in `timezone`. With no
 * items, it says "No workflows yet" when `hasWorkflows` is false, and "No
 * workflows match" when the filter and the search hide every workflow.
 */
export function WorkflowList({
  items,
  hasWorkflows,
  timezone,
}: {
  readonly items: ReadonlyArray<WorkflowListItem>;
  readonly hasWorkflows: boolean;
  readonly timezone: string;
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  // The floating header keeps its search pill clear of a classic scroll bar
  // (floating-header.css).
  const showsScrollbar = useShowsClassicScrollbar(scrollRef);
  return (
    <VirtualList
      scrollRef={scrollRef}
      className={
        showsScrollbar
          ? "workflow-list workflow-list--table has-scrollbar"
          : "workflow-list workflow-list--table"
      }
      aria-label="Workflows"
      items={items}
      computeItemHeight={computeItemHeight}
      renderItem={(item, index, onScreen) => renderItem(item, index, onScreen, timezone)}
      pickFocusFallback={pickWorkflowFocusFallback}
      head={TABLE_HEAD}
    >
      {items.length === 0 ? (
        <p className="workflow-list-empty">
          {hasWorkflows ? "No workflows match" : "No workflows yet"}
        </p>
      ) : null}
    </VirtualList>
  );
}
