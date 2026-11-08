import { Fragment, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { InboxLayout, RequestsOrder } from "@hercule/client-core/inbox";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { ChoiceMenu, SectionHeading, Sunrise } from "../desk";
import type { CardHandOffs } from "./card-props";
import { RequestCard } from "./request-card";
import { WithSomeoneElse } from "./with-someone-else";

/** The ways Requests can be ordered, with the words the control shows. */
const ORDERS: ReadonlyArray<{ readonly id: RequestsOrder; readonly name: string }> = [
  { id: "oldest", name: "Oldest first" },
  { id: "mine", name: "Mine first" },
  { id: "place", name: "By place" },
];

/**
 * Renders the control at the end of the Requests heading: the order in use,
 * with a chevron, and a menu of the three orders. Picking one closes the menu
 * and calls `onChange`. It changes no number anywhere.
 */
function RequestsOrderControl({
  order,
  onChange,
}: {
  readonly order: RequestsOrder;
  readonly onChange: (order: RequestsOrder) => void;
}): JSX.Element {
  const current = ORDERS.find((each) => each.id === order) ?? ORDERS[0];
  return (
    <ChoiceMenu
      label="Order requests"
      edge="button-end"
      entries={ORDERS}
      chosenId={current?.id}
      onPick={onChange}
      renderTrigger={(triggerProps) => (
        <button {...triggerProps} type="button" className="inbox-order" title="Order requests">
          <span>{current?.name}</span>
          <ChevronDownIcon size={16} />
        </button>
      )}
    />
  );
}

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
 * Renders the narrow column: the "Requests" heading with its small count and
 * the order control, then the cards in the order the layout gives (each place
 * labelled when ordered by place), then With someone else at the foot.
 *
 * - `layout` is the page's layout (`layOutInbox`); the column draws its
 *   `requests` and `withSomeoneElse` parts.
 * - `plugins` is what `plugin.query` returns, for the marks.
 * - `monogram` is the user's, for the cards that a Task holds.
 * - `freshIds` are the cards a signal just landed on, which show the new mark.
 * - `handOffs` are what the cards need to draw a hand-off (`CardHandOffs`).
 * - `isSunriseStill` is false when the user's own move just left no request,
 *   so the small sunrise plays.
 *
 * The cards stand as `.inbox-request` elements, keyed by the id of their card,
 * in one list for each group inside `.inbox-requests`.
 */
export function RequestsSide({
  layout,
  requestsOrder,
  onOrderChange,
  plugins,
  monogram,
  freshIds,
  handOffs,
  isSunriseStill,
}: {
  readonly layout: InboxLayout;
  readonly requestsOrder: RequestsOrder;
  readonly onOrderChange: (order: RequestsOrder) => void;
  readonly plugins: readonly PluginIdentity[];
  readonly monogram: string;
  readonly freshIds: ReadonlySet<string>;
  readonly handOffs: CardHandOffs;
  readonly isSunriseStill: boolean;
}): JSX.Element {
  const { requests, withSomeoneElse } = layout;
  const stepOfCard = new Map(
    requests.groups.flatMap((group) => group.rows).map((row, index) => [row.card.id, index]),
  );
  return (
    <aside className="inbox-narrow" aria-label="Requests" style={{ "--arrive-block": 1 }}>
      <div className="inbox-section-head">
        <SectionHeading name="Requests" count={requests.awaitingCount} />
        <RequestsOrderControl order={requestsOrder} onChange={onOrderChange} />
      </div>
      <div className="inbox-requests">
        {requests.groups.map((group) => (
          <Fragment key={group.label ?? ""}>
            {group.label !== undefined && <h3 className="inbox-requests-label">{group.label}</h3>}
            <div className="inbox-requests-group" role="list">
              {group.rows.map((row) => (
                <RequestCard
                  key={row.card.id}
                  card={row.card}
                  homeName={row.homeName}
                  bundle={row.bundle}
                  freshIds={freshIds}
                  handOffs={handOffs}
                  plugins={plugins}
                  monogram={monogram}
                  step={stepOfCard.get(row.card.id) ?? 0}
                />
              ))}
            </div>
          </Fragment>
        ))}
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
        handOffs={handOffs}
      />
    </aside>
  );
}
