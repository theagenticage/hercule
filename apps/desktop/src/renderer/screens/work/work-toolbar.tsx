import type { JSX, KeyboardEvent, ReactNode, Ref } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import {
  buildFilterChips,
  FROM_YOUR_SOURCES_HEADING,
  type Filter,
  type FilterFacet,
} from "@hercule/client-core/desk";
import {
  PROJECT_FACET_ID,
  SOURCE_FACET_ID,
  STAGE_NAMES,
  type BoardGrouping,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { ConnectionsIcon } from "../../icons/connections";
import { FolderIcon } from "../../icons/folder";
import { PlusIcon } from "../../icons/plus";
import { SlidersIcon } from "../../icons/sliders";
import { PluginMark } from "../../marks";
import {
  ChoiceMenu,
  FilterChips,
  FilterControl,
  FindBox,
  IconPill,
  MenuAction,
  MenuLine,
  MenuSegment,
  MenuSwitch,
  Toolbar,
  ToolButton,
  ToolMenu,
  type ChoiceMenuEntry,
  type FindMatch,
} from "../desk";
import { usePopoverMenu } from "../use-popover-menu";
import type { WorkDisplay } from "./use-work-view";
import "./work-toolbar.css";

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

/** The mark in front of Project and Source, by the id of the grouping or facet. */
const MARKS: Readonly<Record<string, ReactNode>> = {
  [PROJECT_FACET_ID]: <FolderIcon size={14} />,
  [SOURCE_FACET_ID]: <ConnectionsIcon size={14} />,
};

/** Returns the mark in front of each kind of outside place, by kind: its plugin's mark. */
const buildSourceMarks = (
  groupings: readonly BoardGrouping[],
  plugins: readonly PluginIdentity[],
): Readonly<Record<string, ReactNode>> =>
  Object.fromEntries(
    groupings.flatMap((grouping) =>
      grouping.pluginId === null
        ? []
        : [
            [
              grouping.kind,
              <PluginMark pluginId={grouping.pluginId} plugins={plugins} size={14} />,
            ],
          ],
    ),
  );

/** The two ways lanes can label themselves, as the Display menu words them. */
const LANE_LABEL_CHOICES = [
  { view: "side-labels", label: "Side labels" },
  { view: "bands", label: "Bands" },
] as const;

/**
 * Renders the Group by button and its menu: Project, then under "From your
 * sources" each kind of outside place the board can group by, with its
 * plugin's mark. The board's own grouping is on. Picking one closes the menu
 * and calls `onChange` with the grouping's id (`PROJECT_FACET_ID` or a kind).
 */
function GroupByControl({
  groupBy,
  groupings,
  marks,
  onChange,
}: {
  readonly groupBy: string;
  readonly groupings: readonly BoardGrouping[];
  readonly marks: Readonly<Record<string, ReactNode>>;
  readonly onChange: (groupBy: string) => void;
}): JSX.Element {
  const name = groupings.find((grouping) => grouping.kind === groupBy)?.caption ?? "Project";
  const entries: readonly ChoiceMenuEntry<string>[] = [
    { id: PROJECT_FACET_ID, name: "Project", mark: MARKS[PROJECT_FACET_ID] },
    ...(groupings.length > 0 ? [{ heading: FROM_YOUR_SOURCES_HEADING }] : []),
    ...groupings.map((grouping) => ({
      id: grouping.kind,
      name: grouping.caption,
      mark: marks[grouping.kind],
    })),
  ];
  return (
    <ChoiceMenu
      label="Group by"
      edge="start"
      entries={entries}
      chosenId={groupBy}
      onPick={onChange}
      renderTrigger={(triggerProps) => (
        <ToolButton {...triggerProps} caption="Group by" name={name} hasMenu isFilled={false} />
      )}
    />
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
 * - `groupings` are the kinds of outside place the board can group by, and
 *   `groupBy` what it groups by now (`PROJECT_FACET_ID` or one of their
 *   kinds). A pick goes to `onGroupByChange`. `plugins` give the marks.
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
  groupings,
  groupBy,
  onGroupByChange,
  plugins,
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
  readonly groupings: readonly BoardGrouping[];
  readonly groupBy: string;
  readonly onGroupByChange: (groupBy: string) => void;
  readonly plugins: readonly PluginIdentity[];
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
  const sourceMarks = buildSourceMarks(groupings, plugins);
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
      <GroupByControl
        groupBy={groupBy}
        groupings={groupings}
        marks={sourceMarks}
        onChange={onGroupByChange}
      />
      <FilterControl
        facets={facets}
        filter={filter}
        items={cards}
        marks={{ ...MARKS, ...sourceMarks }}
        onFilterChange={onFilterChange}
      />
      <FilterChips chips={chips} filter={filter} onFilterChange={onFilterChange} />
    </Toolbar>
  );
}
