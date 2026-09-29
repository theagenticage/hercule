import type { JSX } from "react";
import { IconFrame, type IconProps } from "./icon-frame";

// The icons the v1 desktop pages draw, one exported component each. The
// bundler drops every component nothing imports, so a screen ships only the
// icons it uses. A single component that takes the icon's name would ship
// all of them.
//
// Every coordinate is copied from the Bureau book's crew.js as the same
// string, so the markup matches the book's attribute for attribute. The book
// fills small dots (radius .4 to .6) at runtime; here the fill is written on
// the dot itself.

/** Renders the branch icon: three commits, the side branch curving into the trunk. */
export function BranchIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="4.6" cy="3.6" r="1.5" />
      <circle cx="4.6" cy="12.4" r="1.5" />
      <circle cx="11.4" cy="5.6" r="1.5" />
      <path d="M4.6 5.1v5.8M11.4 7.1c0 2.6-4.4 2.4-6.4 4" />
    </IconFrame>
  );
}

/** Renders the clock icon: a dial with its two hands. */
export function ClockIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 5v3.2l2 1.4" />
    </IconFrame>
  );
}

/** Renders the compose icon: a pencil writing on an open sheet. */
export function ComposeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M7.4 2.8H4.2a1.4 1.4 0 0 0-1.4 1.4v7.6a1.4 1.4 0 0 0 1.4 1.4h7.6a1.4 1.4 0 0 0 1.4-1.4V8.6" />
      <path d="M11.6 2.4l2 2-5.4 5.4-2.6.6.6-2.6z" />
    </IconFrame>
  );
}

/** Renders the diff icon: a plus at the top left and a minus at the bottom right. */
export function DiffIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M5 2.6v6M2 5.6h6M8.6 11.8H14" />
    </IconFrame>
  );
}

/** Renders the editor icon: a slash between two angle brackets. */
export function EditorIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M5.4 4.6L2.4 8l3 3.4M10.6 4.6l3 3.4-3 3.4M9.2 3.2L6.8 12.8" />
    </IconFrame>
  );
}

/** Renders the external icon: an arrow leaving a box, for a link that opens outside the app. */
export function ExternalIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6.4 3.4H4a1.2 1.2 0 0 0-1.2 1.2V12A1.2 1.2 0 0 0 4 13.2h7.4a1.2 1.2 0 0 0 1.2-1.2V9.6M9 2.8h4.2V7M13 3l-5.6 5.6" />
    </IconFrame>
  );
}

/** Renders the Intake icon: an inbox tray. */
export function IntakeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 9.2h3.2l1 1.8h2.8l1-1.8h3.2" />
      <path d="M2.4 9.2l1.6-5.4h8l1.6 5.4v3.6a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z" />
    </IconFrame>
  );
}

/** Renders the laptop icon: a screen above a base line. */
export function LaptopIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="3.4" y="3.4" width="9.2" height="6.6" rx="1.2" />
      <path d="M1.8 12.6h12.4" />
    </IconFrame>
  );
}

/** Renders the microphone icon: a capsule in its stand. */
export function MicIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="5.8" y="2" width="4.4" height="7.6" rx="2.2" />
      <path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2" />
    </IconFrame>
  );
}

/** Renders the more icon: three filled dots in a row. */
export function MoreIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="3.6" cy="8" r=".6" fill="currentColor" />
      <circle cx="8" cy="8" r=".6" fill="currentColor" />
      <circle cx="12.4" cy="8" r=".6" fill="currentColor" />
    </IconFrame>
  );
}

/** Renders the plus icon. */
export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </IconFrame>
  );
}

/** Renders the search icon: a lens and its handle. */
export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="M10.5 10.5l3 3" />
    </IconFrame>
  );
}

/** Renders the send icon: an arrow pointing up. */
export function SendIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 13V3.4M4 7.2L8 3.2l4 4" />
    </IconFrame>
  );
}

/** Renders the shield icon: a shield with a check mark. */
export function ShieldIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 2.2l4.8 1.8v3.8c0 3-2.2 5.2-4.8 6-2.6-.8-4.8-3-4.8-6V4z" />
      <path d="M5.8 8.2l1.6 1.5 2.8-3" />
    </IconFrame>
  );
}

/** Renders the sidebar icon: a window with its left pane divided off. */
export function SidebarIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="2" />
      <path d="M6.2 2.8v10.4" />
    </IconFrame>
  );
}

/** Renders the sliders icon: two lines, each with a knob. */
export function SlidersIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3 5h5.4M11.6 5H13M3 11h1.4M7.6 11H13" />
      <circle cx="10" cy="5" r="1.6" />
      <circle cx="6" cy="11" r="1.6" />
    </IconFrame>
  );
}

/** Renders the tasks icon: a check mark in a rounded square. */
export function TasksIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="3" />
      <path d="M5.4 8.2l1.8 1.7 3.4-3.6" />
    </IconFrame>
  );
}

/** Renders the workspace icon: a folder. */
export function WorkspaceIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 4.2a1 1 0 0 1 1-1h3l1.4 1.6h4.8a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H3.4a1 1 0 0 1-1-1z" />
    </IconFrame>
  );
}
