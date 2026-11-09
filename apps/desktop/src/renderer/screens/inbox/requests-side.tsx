import { Fragment, useId, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type {
  InboxLayout,
  RequestsGrouping,
  RequestsShow,
  RequestsSort,
} from "@hercule/client-core/inbox";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { SectionHeading, Sunrise } from "../desk";
import { RequestCard } from "./request-card";
import { RequestsViewControl } from "./requests-view-control";
import { WithSomeoneElse } from "./with-someone-else";

/**
 * Renders what the column says when it holds no request: a small sunrise
 * and "No requests left." when the user has none (lasting work never ends, so
 * finishing the requests deserves its moment), or a line when the filter
 * hides the ones they have.
 */
function NoRequests({
  isEmptiedByFilter,
  isSunriseStill,
}: {
  readonly isEmptiedByFilter: boolean;
  readonly isSunriseStill: boolean;
}): JSX.Element {
  if (isEmptiedByFilter) return <p className="inbox-none">Nothing here matches this filter.</p>;
  return (
    <div className="inbox-requests-clear">
      <Sunrise width={240} isStill={isSunriseStill} />
      <p>No requests left.</p>
    </div>
  );
}

/**
 * Renders the header of a Requests group: one button with a chevron (down
 * when the group is open, right when it is folded), the place's name and,
 * only while folded, how many requests it holds. Pressing it calls `onToggle`.
 * `listId` is the id of the group's list, which the button controls.
 */
function GroupHeader({
  id,
  label,
  count,
  isFolded,
  listId,
  onToggle,
}: {
  readonly id: string;
  readonly label: string;
  readonly count: number;
  readonly isFolded: boolean;
  readonly listId: string;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="inbox-requests-label"
      data-group-id={id}
      aria-expanded={!isFolded}
      aria-controls={listId}
      onClick={onToggle}
    >
      {isFolded ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}
      <span className="inbox-requests-name">{label}</span>
      {isFolded && <span className="inbox-requests-count">{count}</span>}
    </button>
  );
}

/**
 * Renders the narrow column: the "Requests" heading with its small count and
 * the view control, then the cards in the order the layout gives (each place
 * a group with a header when grouped by place), then With someone else at the
 * foot.
 *
 * - `layout` is the page's layout (`layOutInbox`); the column draws its
 *   `requests` and `withSomeoneElse` parts.
 * - `show`, `grouping` and `sort` are the choices of the view control, and
 *   `onShowChange`, `onGroupingChange` and `onSortChange` hear a change.
 * - `collapsedGroups` are the ids of the groups the user folded
 *   (`RequestGroup.id`). A folded group draws its header and count and none
 *   of its cards, so the keys, which read cards from the page, skip them.
 *   `onToggleGroup` folds or opens one.
 * - `plugins` is what `plugin.query` returns, for the marks.
 * - `monogram` is the user's, for the cards that a Task holds.
 * - `freshIds` are the cards a signal just landed on, which show the new mark.
 * - `isSunriseStill` is false when the user's own move just left no request,
 *   so the small sunrise plays.
 *
 * The cards stand as `.inbox-request` elements, keyed by the id of their card,
 * in one list for each group inside `.inbox-requests`.
 */
export function RequestsSide({
  layout,
  show,
  grouping,
  sort,
  onShowChange,
  onGroupingChange,
  onSortChange,
  collapsedGroups,
  onToggleGroup,
  plugins,
  monogram,
  freshIds,
  isSunriseStill,
}: {
  readonly layout: InboxLayout;
  readonly show: RequestsShow;
  readonly grouping: RequestsGrouping;
  readonly sort: RequestsSort;
  readonly onShowChange: (show: RequestsShow) => void;
  readonly onGroupingChange: (grouping: RequestsGrouping) => void;
  readonly onSortChange: (sort: RequestsSort) => void;
  readonly collapsedGroups: ReadonlySet<string>;
  readonly onToggleGroup: (id: string) => void;
  readonly plugins: readonly PluginIdentity[];
  readonly monogram: string;
  readonly freshIds: ReadonlySet<string>;
  readonly isSunriseStill: boolean;
}): JSX.Element {
  const { requests, withSomeoneElse } = layout;
  const listIdBase = useId();
  // The arrival step of a group's first card counts the cards that are drawn, so a folded group takes none.
  const firstSteps: number[] = [];
  let drawnCount = 0;
  for (const group of requests.groups) {
    firstSteps.push(drawnCount);
    if (group.label === undefined || !collapsedGroups.has(group.id))
      drawnCount += group.rows.length;
  }
  return (
    <aside className="inbox-narrow" aria-label="Requests" style={{ "--arrive-block": 1 }}>
      <div className="inbox-section-head">
        <SectionHeading name="Requests" count={requests.awaitingCount} />
        <RequestsViewControl
          show={show}
          grouping={grouping}
          sort={sort}
          people={requests.people}
          onShowChange={onShowChange}
          onGroupingChange={onGroupingChange}
          onSortChange={onSortChange}
        />
      </div>
      <div className="inbox-requests">
        {requests.groups.map((group, index) => {
          const listId = `${listIdBase}-${index}`;
          const isFolded = group.label !== undefined && collapsedGroups.has(group.id);
          return (
            <Fragment key={group.id}>
              {group.label !== undefined && (
                <GroupHeader
                  id={group.id}
                  label={group.label}
                  count={group.rows.length}
                  isFolded={isFolded}
                  listId={listId}
                  onToggle={() => {
                    onToggleGroup(group.id);
                  }}
                />
              )}
              {/* Kept mounted while folded, so the header's aria-controls names an element that exists. */}
              <div id={listId} className="inbox-requests-group" role="list" hidden={isFolded}>
                {!isFolded &&
                  group.rows.map((row, rowIndex) => (
                    <RequestCard
                      key={row.card.id}
                      card={row.card}
                      homeName={row.homeName}
                      bundle={row.bundle}
                      freshIds={freshIds}
                      offers={row.offers}
                      plugins={plugins}
                      monogram={monogram}
                      step={(firstSteps[index] ?? 0) + rowIndex}
                    />
                  ))}
              </div>
            </Fragment>
          );
        })}
      </div>
      {requests.isEmpty && (
        <NoRequests
          isEmptiedByFilter={requests.isEmptiedByFilter}
          isSunriseStill={isSunriseStill}
        />
      )}
      <WithSomeoneElse
        rows={withSomeoneElse.rows}
        plugins={plugins}
        monogram={monogram}
        freshIds={freshIds}
      />
    </aside>
  );
}
