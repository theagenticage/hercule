/**
 * The app's specimen sheet: every cell of `cells.ts`, drawn with the app's own
 * components. `pnpm compare:bureau` compares it pixel for pixel with the
 * reference sheet, which draws the same cells with the Bureau book's crew.js.
 *
 * The page takes two options from its URL:
 * - `?theme=whitehaven` or `?theme=orient-express`;
 * - `?animated=1` passes `animated` to every face, so the working faces tap
 *   their paws while Reduce motion is off. The comparison never sets it.
 *
 * The sheet is for development only. The dev server serves it at
 * `/specimens/`, and the release build never includes it: the build's only
 * input is `src/renderer/index.html`, and eslint refuses any import of this
 * folder from outside it.
 */
import "../styles/tokens.css";
import "../styles/base.css";
import "./sheet.css";
import type { JSX } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { buildLook, Face, UserAvatar } from "../faces";
import {
  BranchIcon,
  ClockIcon,
  ComposeIcon,
  DiffIcon,
  EditorIcon,
  ExternalIcon,
  IntakeIcon,
  LaptopIcon,
  MicIcon,
  MoreIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  SidebarIcon,
  SlidersIcon,
  TasksIcon,
  WorkspaceIcon,
  type IconProps,
} from "../icons";
import { Mark } from "../marks";
import { SHEET, type IconName, type Piece } from "./cells";
import { applySheetTheme, markSheetReady } from "./sheet-page";

// The screens import each icon by its own name, so a screen ships only the
// icons it uses. The sheet draws every icon, so it may look them up by name.
const ICONS: { readonly [Name in IconName]: (props: IconProps) => JSX.Element } = {
  branch: BranchIcon,
  clock: ClockIcon,
  compose: ComposeIcon,
  diff: DiffIcon,
  editor: EditorIcon,
  external: ExternalIcon,
  intake: IntakeIcon,
  laptop: LaptopIcon,
  mic: MicIcon,
  more: MoreIcon,
  plus: PlusIcon,
  search: SearchIcon,
  send: SendIcon,
  shield: ShieldIcon,
  sidebar: SidebarIcon,
  sliders: SlidersIcon,
  tasks: TasksIcon,
  workspace: WorkspaceIcon,
};

const animated = new URLSearchParams(location.search).get("animated") === "1";

/** Renders one cell's piece with the app's component for it. */
function Specimen({ piece }: { readonly piece: Piece }): JSX.Element {
  switch (piece.kind) {
    case "face":
      return (
        <Face
          look={piece.look}
          pose={piece.pose}
          size={piece.size}
          label="Specimen"
          animated={animated}
        />
      );
    case "seeded-face":
      return (
        <Face
          look={buildLook(piece.seed)}
          pose="idle"
          size={piece.size}
          label={piece.seed}
          animated={animated}
        />
      );
    case "avatar":
      // The Bureau book draws the avatar for "Rogier", and its letter is part of the picture.
      return <UserAvatar name="Rogier" size={piece.size} />;
    case "mark":
      return <Mark state={piece.state} />;
    case "icon": {
      const Icon = ICONS[piece.icon];
      return <Icon size={piece.size} />;
    }
  }
}

applySheetTheme();
const sheet = document.getElementById("sheet");
if (sheet === null) {
  throw new Error("specimens/index.html is missing #sheet");
}
// Rendered synchronously, so the cells are in the document before the
// readiness check below measures them.
flushSync(() => {
  createRoot(sheet).render(
    SHEET.map((row, index) => (
      <div className="sheet-row" key={index}>
        {row.map((cell) => (
          <div data-cell={cell.name} key={cell.name}>
            <Specimen piece={cell.piece} />
          </div>
        ))}
      </div>
    )),
  );
});
await markSheetReady();
