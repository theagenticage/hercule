/**
 * The desk: what Work and the Inbox both draw. Every part here is
 * presentational. It takes values and callbacks and reads nothing: no query
 * cache, no router and no live connection. A part that only one page needs
 * belongs in that page's folder (`screens/work/`, `screens/inbox/`). A part a
 * second page could use belongs here.
 *
 * - `Card`, `Colleague`: the card sheet, and the colleague standing behind
 *   its top edge.
 * - `Toolbar`, `ToolButton`, `IconPill`, `FilterChip`, `ClearChipsButton`,
 *   `FindBox`, `ToolMenu` and the menu rows: the toolbar's row, its controls
 *   and its menus.
 * - `FilterControl`, `FilterChips`: the Filter button with its menu, and the
 *   chips of what is chosen, for any list of items.
 * - `useDeskAgeLabel`: the age a card shows, kept current by the age clock.
 *   It is the one part here that reads something (the clock).
 * - `ViewPill`: the pill that names a place and switches between its views.
 * - `SectionHeading`, `StatusShape`, `FailedMark`: the small marks and
 *   headings.
 * - `SideSheet`, `UndoLine`, `Sunrise`: the sheet at the right, the line at
 *   the foot, and what shows when all is done.
 */
export { Card, type CardColleague, type CardNowTone } from "./card";
export { Colleague, type ColleaguePose } from "./colleague";
export { FilterChips, FilterControl } from "./filter-control";
export { SectionHeading } from "./section-heading";
export { SideSheet } from "./side-sheet";
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
export { ViewPill } from "./view-pill";
