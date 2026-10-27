/**
 * A list grouped by project, at one of its two widths: the Discussions list
 * and the Wiki list (spec 19 §8.2).
 *
 * - The table, while nothing is open: the column heads in a sticky band as
 *   tall as the floating header, then each project's heading, its
 *   repositories' sub-headings, and its one-line or two-line rows.
 * - The column, beside the open item: the same headings, then two-line rows
 *   as the sidebar draws them.
 *
 * The list draws on the workflow list's rules (`workflow-list.css`): its
 * scrolling pane, its band, its table rows and its column rows. The rules
 * this list adds are in `project-grouped-list.css`.
 *
 * The items are virtualized, each drawn at a height that follows the Text
 * size with the space above it as its top margin, and the next page is read
 * when the last item is mounted.
 */
import { memo, useCallback, useRef, type JSX, type ReactNode } from "react";
import { readErrorMessage } from "@hercule/client-core";
import type { ProjectGroupEntry, RepositoryRecord } from "@hercule/client-core/project-groups";
import type { Project } from "@hercule/contract";
import type { ListPaneWidth } from "../list-pane/list-with-open-pane";
import { useMeasuredAtTextSize } from "../../app/text-size";
import { COLUMN_ROW_LEADING, readListHeights, type ListHeights } from "../list-pane/list-row-sizes";
import { useShowsClassicScrollbar } from "../session/classic-scrollbar";
import { pickProjectTint, ProjectTile, type ProjectTint } from "../project-tile";
import { VirtualList } from "../virtual-list";
import "../workflows/workflow-list.css";
import "./project-grouped-list.css";

/** The list's two widths: the table fills the pane, and the column sits beside the open item. */
type ProjectGroupedListWidth = Exclude<ListPaneWidth, "full">;

/**
 * The state of the paged read the list's items come from, as the query that
 * reads them reports it: `useSuspenseInfiniteQuery`'s result fits.
 */
export interface NextPageRead {
  readonly hasNextPage: boolean;
  /** True while any read of the list runs: the next page, or every page read again after a push. */
  readonly isFetching: boolean;
  readonly isFetchingNextPage: boolean;
  /** True while the last read of the next page failed, which `error` then describes. */
  readonly isFetchNextPageError: boolean;
  readonly error: Error | null;
  readonly fetchNextPage: () => Promise<unknown>;
}

/**
 * Where a row sits: what the list tells the screen's row to draw itself at.
 * The row carries `itemKey` as its React key and its `data-key`, and draws
 * itself `marginTop` pixels under the item above it. Its height comes from its
 * CSS, the same one the list places it by (`LIST_HEIGHT_PROPERTIES`).
 */
export interface RowPlace {
  readonly itemKey: string;
  readonly marginTop: number;
  /** Whether the row is in the visible part of the list, which keeps its times current. */
  readonly onScreen: boolean;
}

/**
 * The height of the band above the rows, in CSS pixels: the floating
 * header's 56px, which no row scrolls into view under, then the table's
 * 32px column heads, or 8px over the column. An empty table has no heads.
 */
const HEAD_HEIGHT = { table: 88, column: 64, emptyTable: 56 } as const;

/**
 * Returns the row of the item `itemId` in `list`, or `null` when it is not
 * drawn. An item appears once under each project its repository is in, so
 * this is the first of its rows. The key of an item's row ends in the item's
 * id (`groupByProject`). The id goes into the selector escaped, so no id can
 * change what the selector matches.
 */
export const findGroupedItemRow = (list: Element, itemId: string): HTMLElement | null =>
  list.querySelector<HTMLElement>(`[data-key^="item:"][data-key$=":${CSS.escape(itemId)}"]`);

/** Which of the list's heights a row in the table has: the Discussions' one line, or the Wiki's title over a summary. */
export type TableRowKind = Extract<keyof ListHeights, "oneLineRow" | "twoLineRow">;

/** An entry with the space the list draws above it. */
interface PlacedEntry<Item extends RepositoryRecord> {
  readonly key: string;
  readonly entry: ProjectGroupEntry<Item>;
  readonly marginTop: number;
}

/**
 * Returns the space above the entry at `index` of `entries`, in CSS pixels:
 *
 * - a project's heading sits 14px under the column heads when it is first,
 *   and 22px under the row before it otherwise; in the column, as the
 *   sidebar spaces its groups, 8px and 16px;
 * - a repository's sub-heading sits 2px under its project's heading, and
 *   8px under the row before it, 6px in the column;
 * - a row in the table touches the row above it, which its hairline divides
 *   it from, and a row in the column sits 1px under it, as the sidebar's
 *   rows do.
 */
const computeLeading = <Item extends RepositoryRecord>(
  width: ProjectGroupedListWidth,
  entries: readonly ProjectGroupEntry<Item>[],
  index: number,
): number => {
  const isTable = width === "table";
  switch (entries[index]!.kind) {
    case "project":
      if (index === 0) return isTable ? 14 : 8;
      return isTable ? 22 : 16;
    case "repository":
      if (entries[index - 1]?.kind === "project") return 2;
      return isTable ? 8 : 6;
    case "item":
      return isTable ? 0 : COLUMN_ROW_LEADING;
  }
};

/** Returns the height of `entry` without the space above it, in CSS pixels. */
const computeEntryHeight = <Item extends RepositoryRecord>(
  heights: ListHeights,
  width: ProjectGroupedListWidth,
  entry: ProjectGroupEntry<Item>,
  tableRow: TableRowKind,
): number => {
  switch (entry.kind) {
    case "project":
      return heights.groupHeading;
    case "repository":
      return heights.repositoryHeading;
    case "item":
      return width === "table" ? heights[tableRow] : heights.columnRow;
  }
};

/**
 * Returns the key of the entry that takes focus when the focused entry,
 * `goneKey`, leaves the list: the entry that now sits where it sat, or the
 * last entry when the list is now shorter than that. Returns `null` when the
 * list is now empty. Focus stays in the list, so a keyboard user never lands
 * back at the top of the page.
 */
const pickEntryInPlace = <Item extends RepositoryRecord>(
  goneKey: string,
  before: readonly PlacedEntry<Item>[],
  after: readonly PlacedEntry<Item>[],
): string | null => {
  const index = before.findIndex((placed) => placed.key === goneKey);
  return after[Math.min(Math.max(index, 0), after.length - 1)]?.key ?? null;
};

/**
 * Renders a project's heading: its tile in the project's tint, and its name.
 * The group of items in no project is headed "No project", with an outlined
 * tile.
 */
const ProjectHeading = memo(function ProjectHeading({
  itemKey,
  marginTop,
  tint,
  name,
}: {
  readonly itemKey: string;
  readonly marginTop: number;
  readonly tint: ProjectTint | null;
  readonly name: string;
}): JSX.Element {
  return (
    <h2 className="group-h group-h--proj" data-key={itemKey} tabIndex={-1} style={{ marginTop }}>
      <ProjectTile tint={tint} name={name} />
    </h2>
  );
});

/** Renders a repository's sub-heading, `owner/repo`, indented to its project's name. */
const RepositoryHeading = memo(function RepositoryHeading({
  itemKey,
  marginTop,
  name,
}: {
  readonly itemKey: string;
  readonly marginTop: number;
  readonly name: string;
}): JSX.Element {
  return (
    <h3 className="group-h group-h--repo" data-key={itemKey} tabIndex={-1} style={{ marginTop }}>
      <span>{name}</span>
    </h3>
  );
});

/** What `ProjectGroupedList` takes. */
interface ProjectGroupedListProps<Item extends RepositoryRecord> {
  readonly width: ProjectGroupedListWidth;
  readonly label: string;
  readonly className: string;
  readonly entries: readonly ProjectGroupEntry<Item>[];
  readonly projects: readonly Project[];
  readonly tableHeads: ReactNode;
  readonly tableRow: TableRowKind;
  readonly renderRow: (item: Item, place: RowPlace) => JSX.Element;
  readonly empty: { readonly title: string; readonly text: string };
  readonly nextPage: NextPageRead;
  readonly initialItemId: string | undefined;
}

/**
 * Renders `entries` at `width` under the floating header, in a `nav` named
 * `label`:
 *
 * - `className` names the screen's list, such as `discussion-list`, whose
 *   rules set the table's columns.
 * - `projects` is the project list in its own order, which gives each
 *   project its tint.
 * - `tableHeads` is drawn in the band over the table.
 * - `tableRow` is the height of a row in the table: `oneLineRow` or `twoLineRow`.
 * - `renderRow` returns the element that draws an item at its `RowPlace`.
 * - `empty` is the title and the line under it that the list shows when it
 *   has no entries.
 * - `nextPage` is the state of the read the items come from. The list reads
 *   the next page when its last entry is mounted and no read of the list
 *   runs, except after a read of the next page failed: the list is then
 *   still at its end, so reading again at once would never stop. The list
 *   ends with the error and a Retry instead.
 * - `initialItemId` is the id of the item the list is scrolled to when it
 *   first draws, or `undefined` to start at the top.
 *
 * The list is mounted afresh when `width` changes, because every entry's
 * height changes with it.
 */
export function ProjectGroupedList<Item extends RepositoryRecord>(
  props: ProjectGroupedListProps<Item>,
): JSX.Element {
  return <ProjectGroupedListAtWidth key={props.width} {...props} />;
}

/** Renders the list at the one width it was mounted with. */
function ProjectGroupedListAtWidth<Item extends RepositoryRecord>({
  width,
  label,
  className,
  entries,
  projects,
  tableHeads,
  tableRow,
  renderRow,
  empty,
  nextPage,
  initialItemId,
}: ProjectGroupedListProps<Item>): JSX.Element {
  const scrollRef = useRef<HTMLElement>(null);
  // Over the table, the floating header keeps its pill clear of a classic
  // scroll bar (floating-header.css). The column's scroll bar is not at the
  // pane's right edge, so the header there does not move.
  const showsScrollbar = useShowsClassicScrollbar(scrollRef) && width === "table";
  const isTable = width === "table";
  const isEmpty = entries.length === 0;
  const heights = useMeasuredAtTextSize(readListHeights);
  const placed: readonly PlacedEntry<Item>[] = entries.map((entry, index) => ({
    key: entry.key,
    entry,
    marginTop: computeLeading(width, entries, index),
  }));
  // A new function whenever the heights change, which is how the list knows
  // to place its items again and keep the top one at the top.
  const computePlacedHeight = useCallback(
    (placedEntry: PlacedEntry<Item>): number =>
      placedEntry.marginTop + computeEntryHeight(heights, width, placedEntry.entry, tableRow),
    [heights, width, tableRow],
  );
  const { hasNextPage, isFetching, isFetchingNextPage, isFetchNextPageError, fetchNextPage } =
    nextPage;
  // The next page waits for any read of the list to end, not only a read of
  // the next page. Reading the next page cancels a read of every page that a
  // push started, and the push then reads every page again. While a read of
  // the next page fails, each of those reads clears the failure, so the two
  // would cancel each other and read the failing page without end.
  const readNextPage =
    hasNextPage && !isFetching && !isFetchNextPageError ? () => void fetchNextPage() : undefined;

  const renderEntry = (
    { key, entry, marginTop }: PlacedEntry<Item>,
    _index: number,
    onScreen: boolean,
  ): JSX.Element => {
    switch (entry.kind) {
      case "project":
        return (
          <ProjectHeading
            key={key}
            itemKey={key}
            marginTop={marginTop}
            tint={entry.projectId === null ? null : pickProjectTint(entry.projectId, projects)}
            name={entry.name ?? "No project"}
          />
        );
      case "repository":
        return (
          <RepositoryHeading key={key} itemKey={key} marginTop={marginTop} name={entry.name} />
        );
      case "item":
        return renderRow(entry.item, { itemKey: key, marginTop, onScreen });
    }
  };

  return (
    <VirtualList
      scrollRef={scrollRef}
      className={`workflow-list workflow-list--${width} ${className}${showsScrollbar ? " has-scrollbar" : ""}`}
      aria-label={label}
      items={placed}
      computeItemHeight={computePlacedHeight}
      renderItem={renderEntry}
      pickFocusFallback={pickEntryInPlace}
      isInitialItem={
        initialItemId === undefined
          ? undefined
          : ({ entry }) => entry.kind === "item" && entry.item.id === initialItemId
      }
      onEndReached={readNextPage}
      head={{
        height: isTable
          ? isEmpty
            ? HEAD_HEIGHT.emptyTable
            : HEAD_HEIGHT.table
          : HEAD_HEIGHT.column,
        content: isTable && !isEmpty ? tableHeads : null,
      }}
    >
      {isEmpty ? (
        <p className="list-empty">
          <b>{empty.title}</b>
          <span>{empty.text}</span>
        </p>
      ) : null}
      {isFetchNextPageError ? (
        <p className="list-failure" role="alert">
          <span>Could not read the next page: {readErrorMessage(nextPage.error)}</span>
          <button
            type="button"
            className="btn btn--sm btn--quiet"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            Retry
          </button>
        </p>
      ) : null}
    </VirtualList>
  );
}
