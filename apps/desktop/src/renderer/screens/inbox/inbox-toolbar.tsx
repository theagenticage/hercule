import type { JSX, ReactNode } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import {
  buildFilterChips,
  readEntityPluginId,
  type Filter,
  type FilterFacet,
} from "@hercule/client-core/desk";
import type { InboxGrouping } from "@hercule/client-core/inbox";
import type { InboxCard } from "@hercule/contract";
import { PluginMark } from "../../marks";
import { ChoiceMenu, FilterChips, FilterControl, Toolbar, ToolButton } from "../desk";

/**
 * Renders the Group by button and its menu: the choices the Inbox offers
 * (Place, each kind of place above the work by its caption, then Status),
 * with the one in use on. Picking one closes the menu. Grouping rearranges the
 * wide side and changes no number.
 */
function GroupByControl({
  groupings,
  grouping,
  onPick,
}: {
  readonly groupings: readonly InboxGrouping[];
  readonly grouping: string;
  readonly onPick: (grouping: string) => void;
}): JSX.Element {
  const current = groupings.find((each) => each.id === grouping) ?? groupings[0];
  return (
    <ChoiceMenu
      label="Group by"
      edge="start"
      entries={groupings}
      chosenId={current?.id}
      onPick={onPick}
      renderTrigger={(triggerProps) => (
        <ToolButton
          {...triggerProps}
          caption="Group by"
          name={current?.name ?? "Place"}
          hasMenu
          isFilled={false}
        />
      )}
    />
  );
}

/**
 * Renders the Inbox's toolbar row. It reads nothing: the screen passes what it
 * knows and hears what the user changes.
 *
 * - `pill` is the view pill at the start.
 * - `groupings` and `grouping` are the Group by menu. `facets`, `filter` and
 *   `cards` are the Filter menu: whose it is, then every place on the page.
 *   `cards` are all the cards, so each value counts how many a filter would
 *   leave. What is on shows as chips, and two or more offer Clear.
 * - `showsControls` is false for an Inbox with no card, where Group by and
 *   Filter have nothing to act on.
 * - `notice` is the one line in the bar, after the controls: offline, or a
 *   source that fails.
 * - `end` is the right end of the row.
 *
 * Group by, Filter and the chips run in client-core over the reply already
 * read, so they cost no read and change no number the sidebar shows.
 */
export function InboxToolbar({
  pill,
  groupings,
  grouping,
  onGroupingChange,
  facets,
  filter,
  cards,
  onFilterChange,
  plugins,
  showsControls,
  notice,
  end,
}: {
  readonly pill: ReactNode;
  readonly groupings: readonly InboxGrouping[];
  readonly grouping: string;
  readonly onGroupingChange: (grouping: string) => void;
  readonly facets: readonly FilterFacet<InboxCard>[];
  readonly filter: Filter;
  readonly cards: readonly InboxCard[];
  readonly onFilterChange: (filter: Filter) => void;
  readonly plugins: readonly PluginIdentity[];
  readonly showsControls: boolean;
  readonly notice: ReactNode;
  readonly end: ReactNode;
}): JSX.Element {
  const chips = buildFilterChips(filter, facets);
  // The facets of the places are named for a kind, whose plugin's mark goes in front of the facet's row and its values.
  const marks = Object.fromEntries(
    facets
      .filter((facet) => facet.caption !== "")
      .map((facet) => [
        facet.id,
        <PluginMark
          key={facet.id}
          pluginId={readEntityPluginId(facet.id)}
          plugins={plugins}
          size={14}
        />,
      ]),
  );
  return (
    <Toolbar start={pill} isCrowded={chips.length > 2} end={end}>
      {showsControls && (
        <>
          <GroupByControl groupings={groupings} grouping={grouping} onPick={onGroupingChange} />
          <FilterControl
            facets={facets}
            filter={filter}
            items={cards}
            marks={marks}
            onFilterChange={onFilterChange}
          />
          <FilterChips chips={chips} filter={filter} onFilterChange={onFilterChange} />
        </>
      )}
      {notice}
    </Toolbar>
  );
}
