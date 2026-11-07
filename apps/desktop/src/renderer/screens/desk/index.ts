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
 * - `ViewPill`: the pill that names a place and switches between its views.
 * - `SectionHeading`, `StatusShape`, `FailedMark`: the small marks and
 *   headings.
 * - `SideSheet`, `UndoLine`, `Sunrise`: the sheet at the right, the line at
 *   the foot, and what shows when all is done.
 */
export { Card, type CardColleague, type CardNowTone } from "./card";
export { Colleague, type ColleaguePose } from "./colleague";
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
export { ViewPill } from "./view-pill";
