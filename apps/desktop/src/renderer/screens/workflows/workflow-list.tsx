/**
 * The workflow list at one of its two widths (spec 17 §Workflows, "The
 * list"):
 *
 * - the table, while no workflow is open: the column heads in a sticky band
 *   as tall as the floating header, then each group's heading and its
 *   one-line rows;
 * - the column, beside the open workflow: the search field in that band,
 *   then each group's heading and its two-line rows.
 *
 * The items are virtualized, each drawn at a fixed height.
 */
import { useRef, type JSX, type ReactNode } from "react";
import {
  pickWorkflowFocusFallback,
  type WorkflowListItem,
} from "@hercule/client-core/workflow-rows";
import { useShowsClassicScrollbar } from "../session/classic-scrollbar";
import { VirtualList } from "../virtual-list";
import {
  GROUP_HEADING_HEIGHT,
  WORKFLOW_COLUMN_ROW_HEIGHT,
  WORKFLOW_COLUMN_ROW_LEADING,
  WORKFLOW_ROW_HEIGHT,
  WorkflowColumnRow,
  WorkflowGroupHeading,
  WorkflowTableRow,
} from "./workflow-list-rows";
import "./workflow-list.css";

/** The list's two widths: the table fills the pane, and the column sits beside the open workflow. */
export type WorkflowListWidth = "table" | "column";

/**
 * The height of the band above the rows, in CSS pixels: the floating
 * header's 56px, which no row scrolls into view under, then the table's
 * 32px column heads, or the column's 32px search field and 8px under it.
 */
const HEAD_HEIGHT: Readonly<Record<WorkflowListWidth, number>> = { table: 88, column: 96 };

/**
 * Returns the space above the group heading at `index` in the table, in CSS
 * pixels. The first heading sits 14px under the column heads, and every
 * other one 22px under the row before it.
 */
const computeTableHeadingLeading = (index: number): number => (index === 0 ? 14 : 22);

/**
 * Returns the space above the group heading at `index` in the column, in
 * CSS pixels: the sidebar's spacing, 8px under the search field for the
 * first heading and 16px under the row before it for every other one.
 */
const computeColumnHeadingLeading = (index: number): number => (index === 0 ? 8 : 16);

/** Returns the height of an item in the table with the space above it, in CSS pixels. */
const computeTableItemHeight = (item: WorkflowListItem, index: number): number =>
  item.kind === "group-header"
    ? computeTableHeadingLeading(index) + GROUP_HEADING_HEIGHT
    : WORKFLOW_ROW_HEIGHT;

/** Returns the height of an item in the column with the space above it, in CSS pixels. */
const computeColumnItemHeight = (item: WorkflowListItem, index: number): number =>
  item.kind === "group-header"
    ? computeColumnHeadingLeading(index) + GROUP_HEADING_HEIGHT
    : WORKFLOW_COLUMN_ROW_LEADING + WORKFLOW_COLUMN_ROW_HEIGHT;

/** Returns the element that draws `item` in the table, with its times shown in `timezone`. */
const renderTableItem = (
  item: WorkflowListItem,
  index: number,
  onScreen: boolean,
  timezone: string,
): JSX.Element =>
  item.kind === "group-header" ? (
    <WorkflowGroupHeading
      key={item.key}
      itemKey={item.key}
      leading={computeTableHeadingLeading(index)}
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
      stripRunIds={item.row.stripRunIds}
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

/** Returns the element that draws `item` in the column, with its time shown in `timezone`. */
const renderColumnItem = (
  item: WorkflowListItem,
  index: number,
  onScreen: boolean,
  timezone: string,
): JSX.Element =>
  item.kind === "group-header" ? (
    <WorkflowGroupHeading
      key={item.key}
      itemKey={item.key}
      leading={computeColumnHeadingLeading(index)}
      title={item.title}
      count={item.count}
      isNeedsYou={item.group === "needsYou"}
    />
  ) : (
    <WorkflowColumnRow
      key={item.key}
      itemKey={item.key}
      workflowId={item.row.id}
      name={item.row.name}
      mark={item.row.mark}
      isOff={item.row.isOff}
      statusText={item.row.statusText}
      statusTone={item.row.statusTone}
      lastRunAt={item.row.lastRunAt}
      timezone={timezone}
      onScreen={onScreen}
    />
  );

/**
 * Renders `items` at `width`, with its times shown in `timezone`, under
 * `head`: the column heads over the table, the search field over the
 * column. With no items, it says "No workflows yet" when `hasWorkflows` is
 * false, and "No workflows match" when the filter and the search hide every
 * workflow.
 *
 * The caller mounts the list afresh when `width` changes, because every
 * item's height changes with it.
 */
export function WorkflowList({
  width,
  items,
  hasWorkflows,
  timezone,
  head,
}: {
  readonly width: WorkflowListWidth;
  readonly items: ReadonlyArray<WorkflowListItem>;
  readonly hasWorkflows: boolean;
  readonly timezone: string;
  readonly head: ReactNode;
}): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  // Over the table, the floating header keeps its search pill clear of a
  // classic scroll bar (floating-header.css). The column's scroll bar is not
  // at the pane's right edge, so the header there does not move.
  const showsScrollbar = useShowsClassicScrollbar(scrollRef) && width === "table";
  const isTable = width === "table";
  return (
    <VirtualList
      scrollRef={scrollRef}
      className={`workflow-list workflow-list--${width}${showsScrollbar ? " has-scrollbar" : ""}`}
      aria-label="Workflows"
      items={items}
      computeItemHeight={isTable ? computeTableItemHeight : computeColumnItemHeight}
      renderItem={(item, index, onScreen) =>
        isTable
          ? renderTableItem(item, index, onScreen, timezone)
          : renderColumnItem(item, index, onScreen, timezone)
      }
      pickFocusFallback={pickWorkflowFocusFallback}
      head={{ height: HEAD_HEIGHT[width], content: head }}
    >
      {items.length === 0 ? (
        <p className="workflow-list-empty">
          {hasWorkflows ? "No workflows match" : "No workflows yet"}
        </p>
      ) : null}
    </VirtualList>
  );
}
