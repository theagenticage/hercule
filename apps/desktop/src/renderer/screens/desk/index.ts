/**
 * The desk: what Work and the Inbox both draw. Every part here is
 * presentational. It takes values and callbacks and reads nothing: no query
 * cache, no router and no live connection. A part that only one page needs
 * belongs in that page's folder (`screens/work/`, `screens/inbox/`). A part a
 * second page could use belongs here.
 *
 * - `Card`, `Colleague`: the card sheet, and the colleague standing behind
 *   its top edge. `copyCardForMotion`: a copy of a drawn card to move or to
 *   show where the card was.
 * - `showCauseLabel`, `openDent`: the label that tells why a card is about
 *   to move by itself, and the dent that keeps its place open after it left.
 * - `Toolbar`, `ToolButton`, `IconPill`, `FilterChip`, `ClearChipsButton`,
 *   `FindBox`, `ToolMenu` and the menu rows: the toolbar's row, its controls
 *   and its menus.
 * - `ChoiceMenu`: a "pick one" menu with its button, for how a list is grouped
 *   or ordered.
 * - `FilterControl`, `FilterChips`: the Filter button with its menu, and the
 *   chips of what is chosen, for any list of items.
 * - `useDeskAgeLabel`: the age a card shows, kept current by the age clock.
 * - `useEntitySearch`: the search of things at a source, as Work's Add sheet
 *   and the "Link something" search both run it. These two hooks are the only
 *   parts here that read something (the clock, the query cache).
 * - `LinkSearch`: the "Link something" button and the search it opens, which
 *   reaches every source and reads a pasted link. It sits at the foot of the
 *   Linked section of the details pane and of the Inbox's open card. It reads
 *   the plugins when the search opens, and the search through `useEntitySearch`.
 * - `useFocusPageOnArrival`: gives the page that scrolls the keyboard focus as
 *   it opens, so its keys act after a click on the sidebar.
 * - `ViewPill`: the pill that names a place and switches between its views.
 * - `SectionHeading`, `StatusShape`, `FailedMark`: the small marks and
 *   headings.
 * - `RelationRows`, `ProgressBar`: the rows that draw the places above a
 *   thing, and the 4px bar of a source's reported progress. A place the user
 *   cannot open is a locked row with no title.
 * - `SignalAnswers`, `LedgerAnswer`: the answers of a signal as ledger rows,
 *   with their describe lines and Reply boxes. Intake's pane and the Inbox's
 *   open card both draw them.
 * - `ReadFailure`: the line that says a read failed, with a button to read it
 *   again.
 * - `KeysSheet`: the sheet that lists a page's keys, with Undo and Esc after
 *   them.
 * - `SideSheet`, `OpeningSheet`, `UndoLine`, `Sunrise`: the sheet at the
 *   right that slides in, the one that opens out of a card (it knows nothing
 *   about what it holds), the line at the foot, and what shows when all is
 *   done.
 */
export { Card, type CardColleague, type CardNowTone } from "./card";
export { showCauseLabel } from "./cause-label";
export { ChoiceMenu, type ChoiceMenuEntry } from "./choice-menu";
export { Colleague, type ColleaguePose } from "./colleague";
export { copyCardForMotion } from "./copy-card-for-motion";
export { openDent } from "./dent";
export { FilterChips, FilterControl } from "./filter-control";
export { KeysSheet, type KeyRow } from "./keys-sheet";
export { LinkSearch, type LinkSearchSize } from "./link-search";
export { LedgerAnswer } from "./ledger-answer";
export { ProgressBar } from "./progress-bar";
export { ReadFailure } from "./read-failure";
export { RelationRows } from "./relation-rows";
export { SectionHeading } from "./section-heading";
export { OpeningSheet, type SheetOrigin, type SheetPlaces } from "./opening-sheet";
export type { SheetRect } from "./opening-sheet-geometry";
export { SideSheet } from "./side-sheet";
export { SignalAnswers } from "./signal-answers";
export { FailedMark, StatusShape, type StatusShapeName, type StatusTone } from "./status-shape";
export { Sunrise } from "./sunrise";
export {
  ClearChipsButton,
  FilterChip,
  FindBox,
  IconPill,
  Toolbar,
  ToolButton,
  type FindMatch,
} from "./toolbar";
export {
  MenuAction,
  MenuBack,
  MenuHeading,
  MenuLine,
  MenuPick,
  MenuSegment,
  MenuSwitch,
  ToolMenu,
  type MenuItemProps,
  type MenuPickKind,
} from "./tool-menu";
export { UndoLine } from "./undo-line";
export { useDeskAgeLabel } from "./use-desk-age-label";
export { useEntitySearch } from "./use-entity-search";
export { useFocusPageOnArrival } from "./use-focus-page-on-arrival";
export { ViewPill } from "./view-pill";
