import { useState, type JSX, type ReactNode, type ToggleEvent } from "react";
import { flushSync } from "react-dom";
import {
  countFacetValues,
  EMPTY_FILTER,
  toggleFilterValue,
  type Filter,
  type FilterChipWords,
  type FilterFacet,
  type FilterValue,
} from "@hercule/client-core/desk";
import { FilterIcon } from "../../icons/filter";
import { FOCUSABLE_MENU_ITEM_SELECTOR } from "../move-menu-focus";
import { usePopoverMenu } from "../use-popover-menu";
import { MenuBack, MenuLine, MenuPick, ToolMenu } from "./tool-menu";
import { ClearChipsButton, FilterChip, ToolButton } from "./toolbar";

/** A facet with more values than this opens with a Find box over them. */
const MOST_VALUES_WITHOUT_FIND = 7;

/**
 * Moves the keyboard focus to the first element of `menu` that matches
 * `selector`. Does nothing when `menu` is null or none matches.
 */
const focusInMenu = (menu: HTMLElement | null, selector: string): void => {
  menu?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
};

/**
 * Renders the Filter button and its menu, for a list of `items` and the
 * `facets` that tell how to filter them (see `FilterFacet`).
 *
 * The menu opens on the values of the facet with no caption (such as State)
 * as checkboxes, then one row for each other facet. A facet row opens that
 * facet's values in the same menu, with a Back row, and a Find box over the
 * values when there are more than seven. Each value shows how many of `items`
 * the filter would leave if it were chosen, so `items` must be the items the
 * Find text leaves, not the ones the filter leaves.
 *
 * `marks` puts a mark in front of a facet's row and of its values, by facet
 * id. The values of the facet with no caption read well alone and take none.
 * A change of filter goes to `onFilterChange`.
 *
 * Closing the menu, by Esc or a click outside it, returns it to the first view.
 */
export function FilterControl<Item>({
  facets,
  filter,
  items,
  marks,
  onFilterChange,
}: {
  readonly facets: readonly FilterFacet<Item>[];
  readonly filter: Filter;
  readonly items: readonly Item[];
  readonly marks: Readonly<Record<string, ReactNode>>;
  readonly onFilterChange: (filter: Filter) => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps } = usePopoverMenu();
  const [openFacetId, setOpenFacetId] = useState<string | null>(null);
  const [valueWords, setValueWords] = useState("");

  const firstFacet = facets.find((facet) => facet.caption === "");
  const otherFacets = facets.filter((facet) => facet !== firstFacet);
  const openFacet = facets.find((facet) => facet.id === openFacetId);

  const handleToggle = (event: ToggleEvent<HTMLDivElement>): void => {
    menuProps.onToggle(event);
    if (event.newState === "open") return;
    setOpenFacetId(null);
    setValueWords("");
  };

  /**
   * Switches the menu to a facet's values, or back to the first view with
   * `null`, and puts the focus on what the user can act on: the Find box, the
   * first row, or the row that opened the facet.
   */
  const showFacet = (facetId: string | null, focusSelector: string): void => {
    flushSync(() => {
      setOpenFacetId(facetId);
      setValueWords("");
    });
    focusInMenu(menuProps.ref.current, focusSelector);
  };

  /** Renders the rows of a facet's values, each a checkbox with the count it would leave. */
  const renderValueRows = (
    facet: FilterFacet<Item>,
    values: readonly FilterValue[],
  ): JSX.Element[] => {
    const counts = countFacetValues(items, filter, facets, facet);
    const chosen = filter[facet.id] ?? [];
    return values.map((value) => {
      const isOn = chosen.includes(value.id);
      return (
        <MenuPick
          key={value.id}
          itemProps={buildItemProps(`value:${facet.id}:${value.id}`, { checked: isOn })}
          kind="toggle"
          name={value.name}
          isOn={isOn}
          mark={facet === firstFacet ? undefined : marks[facet.id]}
          count={counts[value.id] ?? 0}
          onPick={() => {
            onFilterChange(toggleFilterValue(filter, facet.id, value.id));
          }}
        />
      );
    });
  };

  const renderFacetValues = (facet: FilterFacet<Item>): JSX.Element => {
    const needle = valueWords.trim().toLowerCase();
    const values = facet.values.filter((value) => value.name.toLowerCase().includes(needle));
    return (
      <>
        <MenuBack
          itemProps={buildItemProps("back")}
          name={facet.caption}
          onBack={() => {
            showFacet(null, `[data-item="open:${facet.id}"]`);
          }}
        />
        {facet.values.length > MOST_VALUES_WITHOUT_FIND && (
          <input
            className="field desk-menu-find"
            placeholder="Find"
            aria-label={`Find in ${facet.caption}`}
            value={valueWords}
            onChange={(event) => {
              setValueWords(event.target.value);
            }}
            onKeyDown={(event) => {
              // Home and End move the caret in a text field. The menu would
              // take them to move between rows.
              if (event.key === "Home" || event.key === "End") event.stopPropagation();
            }}
          />
        )}
        <div className="desk-menu-values">{renderValueRows(facet, values)}</div>
      </>
    );
  };

  const renderFirstView = (): JSX.Element => (
    <>
      {firstFacet !== undefined && renderValueRows(firstFacet, firstFacet.values)}
      {firstFacet !== undefined && otherFacets.length > 0 && <MenuLine />}
      {otherFacets.map((facet) => (
        <MenuPick
          key={facet.id}
          itemProps={buildItemProps(`open:${facet.id}`)}
          kind="opens"
          name={facet.caption}
          isOn={false}
          mark={marks[facet.id]}
          count={(filter[facet.id] ?? []).length}
          onPick={() => {
            const hasFind = facet.values.length > MOST_VALUES_WITHOUT_FIND;
            showFacet(facet.id, hasFind ? ".desk-menu-find" : FOCUSABLE_MENU_ITEM_SELECTOR);
          }}
        />
      ))}
    </>
  );

  return (
    <>
      <ToolButton
        {...triggerProps}
        icon={<FilterIcon size={14} />}
        name="Filter"
        hasMenu={false}
        isFilled={false}
      />
      <ToolMenu menuProps={{ ...menuProps, onToggle: handleToggle }} label="Filter" edge="start">
        {openFacet === undefined ? renderFirstView() : renderFacetValues(openFacet)}
      </ToolMenu>
    </>
  );
}

/**
 * Renders one removable chip for each of `chips` (what `buildFilterChips`
 * returns), then a Clear button when there are two or more. Removing a chip
 * and clearing both go to `onFilterChange` as the whole new filter.
 */
export function FilterChips({
  chips,
  filter,
  onFilterChange,
}: {
  readonly chips: readonly FilterChipWords[];
  readonly filter: Filter;
  readonly onFilterChange: (filter: Filter) => void;
}): JSX.Element {
  return (
    <>
      {chips.map((chip) => (
        <FilterChip
          key={`${chip.facetId}:${chip.valueId}`}
          caption={chip.caption}
          name={chip.name}
          onRemove={() => {
            onFilterChange(toggleFilterValue(filter, chip.facetId, chip.valueId));
          }}
        />
      ))}
      {chips.length > 1 && (
        <ClearChipsButton
          onClear={() => {
            onFilterChange(EMPTY_FILTER);
          }}
        />
      )}
    </>
  );
}
