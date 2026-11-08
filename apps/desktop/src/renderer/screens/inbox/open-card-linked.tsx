import type { JSX, ReactNode } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { LinkedRows, OpenPlaceRow, PlaceRow } from "@hercule/client-core/desk";
import { RelationRows } from "../desk";
import { OpenCardSection } from "./open-card-body";

/**
 * Renders the Linked section of the open card: the things a source or the
 * user says are linked to it, then the references found in text, which it
 * offers to link, and the search that links something else.
 *
 * - `rows` is `buildLinkedRows`'s answer. A linked row names who says it is
 *   linked when it is reached for, and a link the user made has a button that
 *   calls `onUnlink`. A reference found in text has a Link button that calls
 *   `onLink`.
 * - `onWalk` and `canWalk` open a linked thing inside the sheet, for the
 *   rows `canWalk` accepts.
 * - `search` is the "Link something" search, or `null` where nothing can be linked.
 */
export function OpenCardLinked({
  rows,
  plugins,
  onWalk,
  canWalk,
  onUnlink,
  onLink,
  search,
}: {
  readonly rows: LinkedRows;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onWalk: (ref: string) => void;
  readonly canWalk: (row: OpenPlaceRow) => boolean;
  readonly onUnlink: (row: PlaceRow) => void;
  readonly onLink: (row: OpenPlaceRow) => void;
  readonly search: ReactNode;
}): JSX.Element | null {
  if (rows.confirmed.length === 0 && rows.hints.length === 0 && search === null) return null;
  return (
    <OpenCardSection heading="Linked">
      {rows.confirmed.length > 0 && (
        <RelationRows
          rows={rows.confirmed}
          plugins={plugins}
          onWalk={onWalk}
          canWalk={canWalk}
          isKindShown={false}
          onUnlink={onUnlink}
        />
      )}
      {rows.hints.length > 0 && (
        <RelationRows rows={rows.hints} plugins={plugins} isKindShown={false} onLink={onLink} />
      )}
      {search}
    </OpenCardSection>
  );
}
