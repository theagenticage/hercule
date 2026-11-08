import type { JSX, ReactNode } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { STATUS_GROUPING, type InboxLayout } from "@hercule/client-core/inbox";
import { SectionHeading } from "../desk";
import type { CardHandOffs } from "./card-props";
import { PlaceSurface } from "./place-surface";

/**
 * Renders the wide side: the "Ongoing" heading, then lasting work as one
 * raised surface for each place, in the order the layout gives (places in
 * trouble first, then by date, then by name). Nothing folds, and the page
 * scrolls.
 *
 * - `layout` is the page's layout (`layOutInbox`); the side draws its
 *   `ongoing` part and the grouping in use.
 * - What Hercule noticed (triage clusters) is later work, and an empty
 *   noticed card draws nothing, so the page holds no gap for it.
 * - `note` is a quiet line under the work, such as the Inbox being cut short.
 * - `plugins` is what `plugin.query` returns, for the marks.
 * - `monogram` is the user's, for the rows that a Task holds.
 * - `freshIds` are the cards a signal just landed on, which show the new mark.
 * - `handOffs` are what the rows need to draw a hand-off (`CardHandOffs`).
 *
 * The surfaces stand as `.inbox-place` elements keyed by their place's ref.
 */
export function OngoingSide({
  layout,
  plugins,
  monogram,
  freshIds,
  handOffs,
  note,
}: {
  readonly layout: InboxLayout;
  readonly plugins: readonly PluginIdentity[];
  readonly monogram: string;
  readonly freshIds: ReadonlySet<string>;
  readonly handOffs: CardHandOffs;
  readonly note: ReactNode;
}): JSX.Element {
  const { ongoing, grouping } = layout;
  return (
    <div className="inbox-wide">
      <div className="inbox-section-head">
        <SectionHeading name="Ongoing" count={0} />
      </div>
      {ongoing.surfaces.map((surface, index) => (
        <PlaceSurface
          key={surface.head.id}
          surface={surface}
          plugins={plugins}
          showStatus={grouping !== STATUS_GROUPING}
          monogram={monogram}
          freshIds={freshIds}
          handOffs={handOffs}
          block={index + 2}
        />
      ))}
      {ongoing.isEmpty && (
        <p className="inbox-none">
          {ongoing.isEmptiedByFilter
            ? "Nothing here matches this filter."
            : "Nothing ongoing concerns you."}
        </p>
      )}
      {note}
    </div>
  );
}
