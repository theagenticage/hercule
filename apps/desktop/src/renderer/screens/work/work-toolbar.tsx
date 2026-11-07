import {
  useState,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type ToggleEvent,
} from "react";
import { flushSync } from "react-dom";
import {
  buildFilterChips,
  countFacetValues,
  EMPTY_FILTER,
  toggleFilterValue,
  type Filter,
  type FilterFacet,
  type FilterValue,
} from "@hercule/client-core/desk";
import { PROJECT_FACET_ID, STAGE_NAMES, STATE_FACET_ID } from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { FilterIcon } from "../../icons/filter";
import { FolderIcon } from "../../icons/folder";
import { PlusIcon } from "../../icons/plus";
import { SlidersIcon } from "../../icons/sliders";
import {
  ClearChipsButton,
  FilterChip,
  FindBox,
  IconPill,
  MenuAction,
  MenuBack,
  MenuLine,
  MenuPick,
  MenuSegment,
  MenuSwitch,
  Toolbar,
  ToolButton,
  ToolMenu,
  type FindMatch,
} from "../desk";
import { FOCUSABLE_MENU_ITEM_SELECTOR } from "../move-menu-focus";
import { usePopoverMenu } from "../use-popover-menu";
import "./work-toolbar.css";

/** How the lanes label themselves: in a column at the side, or in a band across the top. */
export type LaneLabels = "side-labels" | "bands";

/** The choices of the Display menu. */
export interface WorkDisplay {
  readonly laneLabels: LaneLabels;
  /** Whether the colleagues on the cards hold still: no typing paws, no blinking. */
  readonly isStill: boolean;
  /** Whether single keys, such as A and F, work on the board. */
  readonly hasSingleKeys: boolean;
}

/** What the Find box needs from the board. */
export interface WorkFind {
  /** The text typed in the box. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Lets the board focus the box, such as on `/`. */
  readonly inputRef: Ref<HTMLInputElement>;
  /** Takes the keys of the box, so the board decides what the arrows, Return and Esc do. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** The best few cards for `value`, in the order to list them. */
  readonly matches: readonly WorkCard[];
  /** How many cards hold `value` in their title, of which `matches` lists the first few. */
  readonly totalCount: number;
  /** The id of the match the arrow keys are on, or null. */
  readonly activeId: string | null;
  /** Called with the id of the card to open. */
  readonly onOpen: (id: string) => void;
}

/** A facet with more values than this opens with a Find box over them. */
const MOST_VALUES_WITHOUT_FIND = 7;

/** The mark in front of a grouping, a facet or a value, by the id of the grouping or facet. */
const MARKS: Readonly<Record<string, ReactNode>> = {
  [PROJECT_FACET_ID]: <FolderIcon size={14} />,
};

/** A way to group the lanes. */
interface Grouping {
  readonly id: string;
  readonly name: string;
}

/** The grouping the board is in. Project is the only one, so the board is always in it. */
const PROJECT_GROUPING: Grouping = { id: PROJECT_FACET_ID, name: "Project" };

/** The groupings the Group by menu lists. Each later grouping adds a row here. */
const GROUPINGS: readonly Grouping[] = [PROJECT_GROUPING];

/** The two ways lanes can label themselves, as the Display menu words them. */
const LANE_LABEL_CHOICES = [
  { view: "side-labels", label: "Side labels" },
  { view: "bands", label: "Bands" },
] as const;

/**
 * Moves the keyboard focus to the first element of `menu` that matches
 * `selector`. Does nothing when `menu` is null or none matches.
 */
const focusInMenu = (menu: HTMLElement | null, selector: string): void => {
  menu?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
};

/**
 * Renders the Group by button and its menu. The menu lists `GROUPINGS` as a
 * group of choices, with the board's own on. Picking one closes the menu.
 */
function GroupByControl(): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  return (
    <>
      <ToolButton
        {...triggerProps}
        caption="Group by"
        name={PROJECT_GROUPING.name}
        hasMenu
        isFilled={false}
      />
      <ToolMenu menuProps={menuProps} label="Group by" edge="start">
        {GROUPINGS.map((grouping) => {
          const isOn = grouping.id === PROJECT_GROUPING.id;
          return (
            <MenuPick
              key={grouping.id}
              itemProps={buildItemProps(`group:${grouping.id}`, { checked: isOn })}
              kind="choice"
              name={grouping.name}
              isOn={isOn}
              mark={MARKS[grouping.id]}
              onPick={close}
            />
          );
        })}
      </ToolMenu>
    </>
  );
}

/**
 * Renders the Filter button and its menu. The menu opens on the State facet's
 * values as checkboxes, then one row for each other facet. A facet row opens
 * that facet's values in the same menu, with a Back row, and a Find box over
 * the values when there are more than seven. Each value shows how many cards
 * the filter would leave if it were chosen.
 *
 * Closing the menu, by Esc or a click outside it, returns it to the first view.
 */
function FilterControl({
  facets,
  filter,
  cards,
  onFilterChange,
}: {
  readonly facets: readonly FilterFacet<WorkCard>[];
  readonly filter: Filter;
  readonly cards: readonly WorkCard[];
  readonly onFilterChange: (filter: Filter) => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps } = usePopoverMenu();
  const [openFacetId, setOpenFacetId] = useState<string | null>(null);
  const [valueWords, setValueWords] = useState("");

  const stateFacet = facets.find((facet) => facet.id === STATE_FACET_ID);
  const otherFacets = facets.filter((facet) => facet.id !== STATE_FACET_ID);
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
    facet: FilterFacet<WorkCard>,
    values: readonly FilterValue[],
  ): JSX.Element[] => {
    const counts = countFacetValues(cards, filter, facets, facet);
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
          mark={facet.id === STATE_FACET_ID ? undefined : MARKS[facet.id]}
          count={counts[value.id] ?? 0}
          onPick={() => {
            onFilterChange(toggleFilterValue(filter, facet.id, value.id));
          }}
        />
      );
    });
  };

  const renderFacetValues = (facet: FilterFacet<WorkCard>): JSX.Element => {
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
            className="field work-menu-find"
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
        <div className="work-menu-values">{renderValueRows(facet, values)}</div>
      </>
    );
  };

  const renderFirstView = (): JSX.Element => (
    <>
      {stateFacet !== undefined && renderValueRows(stateFacet, stateFacet.values)}
      {stateFacet !== undefined && otherFacets.length > 0 && <MenuLine />}
      {otherFacets.map((facet) => (
        <MenuPick
          key={facet.id}
          itemProps={buildItemProps(`open:${facet.id}`)}
          kind="opens"
          name={facet.caption}
          isOn={false}
          mark={MARKS[facet.id]}
          count={(filter[facet.id] ?? []).length}
          onPick={() => {
            const hasFind = facet.values.length > MOST_VALUES_WITHOUT_FIND;
            showFacet(facet.id, hasFind ? ".work-menu-find" : FOCUSABLE_MENU_ITEM_SELECTOR);
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
 * Renders the Display button, a square with sliders, and its menu: how lanes
 * label themselves, the two switches, Fold everything, and Keys, which opens
 * the sheet of keys. A change is sent to `onChange` as the whole new `display`.
 */
function DisplayControl({
  display,
  onChange,
  onFoldEverything,
  onShowKeys,
}: {
  readonly display: WorkDisplay;
  readonly onChange: (display: WorkDisplay) => void;
  readonly onFoldEverything: () => void;
  readonly onShowKeys: () => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();
  return (
    <>
      <IconPill {...triggerProps} label="Display">
        <SlidersIcon size={16} />
      </IconPill>
      <ToolMenu menuProps={menuProps} label="Display" edge="end">
        <MenuSegment
          name="Lanes"
          choices={LANE_LABEL_CHOICES}
          choice={display.laneLabels}
          onPick={(laneLabels) => {
            onChange({ ...display, laneLabels });
          }}
        />
        <MenuLine />
        <MenuSwitch
          itemProps={buildItemProps("still")}
          name="Still colleagues"
          description="No typing paws, no blinking."
          isOn={display.isStill}
          onToggle={() => {
            onChange({ ...display, isStill: !display.isStill });
          }}
        />
        <MenuSwitch
          itemProps={buildItemProps("single-keys")}
          name="Single-key shortcuts"
          description="A, F, 1 to 5 and the rest."
          isOn={display.hasSingleKeys}
          onToggle={() => {
            onChange({ ...display, hasSingleKeys: !display.hasSingleKeys });
          }}
        />
        <MenuLine />
        <MenuAction
          itemProps={buildItemProps("fold-everything")}
          name="Fold everything"
          shortcut="⇧F"
          onPick={() => {
            close();
            onFoldEverything();
          }}
        />
        <MenuAction
          itemProps={buildItemProps("keys")}
          name="Keys"
          shortcut="?"
          onPick={() => {
            close();
            onShowKeys();
          }}
        />
      </ToolMenu>
    </>
  );
}

/**
 * Returns what a Find match says under its title: the Project it is in and its
 * stage, such as "Storefront, In review". The Project's name is read from the
 * Project facet, so a card of a deleted Project gets the name the facet gives it.
 */
const describeFindMatch = (card: WorkCard, facets: readonly FilterFacet<WorkCard>[]): FindMatch => {
  const projectFacet = facets.find((facet) => facet.id === PROJECT_FACET_ID);
  const project = projectFacet?.values.find((value) => projectFacet.hasValue(card, value.id));
  return {
    id: card.id,
    title: card.title,
    detail: [project?.name, STAGE_NAMES[card.stage]]
      .filter((word) => word !== undefined)
      .join(", "),
  };
};

/**
 * Renders the Work board's toolbar row. It reads nothing: the board passes
 * what it knows and hears what the user changes.
 *
 * - `pill` is the view pill at the start.
 * - `facets` are the Filter menu's facets, and `filter` what is chosen in
 *   them. `cards` are the cards the Find text leaves, so that each value
 *   counts how many it would leave on top of the Find text. A change of
 *   filter goes to `onFilterChange`: what is on shows as chips beside Filter,
 *   and two or more offer Clear.
 * - `find` is the Find box (see `WorkFind`).
 * - `display` and `onDisplayChange` are the Display menu, and Fold
 *   everything calls `onFoldEverything` and Keys calls `onShowKeys`.
 * - `onAdd` opens Add to Work.
 * - `line` is a quiet line before Find, such as what just happened on the
 *   board. It gives its room to the chips, so it is not drawn while a filter
 *   is on.
 */
export function WorkToolbar({
  pill,
  facets,
  filter,
  onFilterChange,
  cards,
  find,
  display,
  onDisplayChange,
  onFoldEverything,
  onShowKeys,
  onAdd,
  line,
}: {
  readonly pill: ReactNode;
  readonly facets: readonly FilterFacet<WorkCard>[];
  readonly filter: Filter;
  readonly onFilterChange: (filter: Filter) => void;
  readonly cards: readonly WorkCard[];
  readonly find: WorkFind;
  readonly display: WorkDisplay;
  readonly onDisplayChange: (display: WorkDisplay) => void;
  readonly onFoldEverything: () => void;
  readonly onShowKeys: () => void;
  readonly onAdd: () => void;
  readonly line: ReactNode;
}): JSX.Element {
  const chips = buildFilterChips(filter, facets);
  return (
    <Toolbar
      start={pill}
      isCrowded={chips.length > 2}
      end={
        <>
          {chips.length === 0 && <div className="work-toolbar-line">{line}</div>}
          <FindBox
            value={find.value}
            onChange={find.onChange}
            onKeyDown={find.onKeyDown}
            inputRef={find.inputRef}
            placeholder="Find on the board"
            noMatchText={`Nothing here matches "${find.value.trim()}".`}
            matches={find.matches.map((card) => describeFindMatch(card, facets))}
            totalCount={find.totalCount}
            activeId={find.activeId}
            onOpen={find.onOpen}
          />
          <DisplayControl
            display={display}
            onChange={onDisplayChange}
            onFoldEverything={onFoldEverything}
            onShowKeys={onShowKeys}
          />
          <ToolButton
            name="Add"
            icon={<PlusIcon size={14} />}
            title="Add to Work"
            hasMenu={false}
            isFilled
            onClick={onAdd}
          />
        </>
      }
    >
      <GroupByControl />
      <FilterControl
        facets={facets}
        filter={filter}
        cards={cards}
        onFilterChange={onFilterChange}
      />
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
    </Toolbar>
  );
}
