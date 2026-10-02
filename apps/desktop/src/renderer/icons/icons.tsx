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

/** Renders the check icon: a check mark. */
export function CheckIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3.4 8.4l3 3 6.2-6.6" />
    </IconFrame>
  );
}

/** Renders the chevron-right icon: an angle pointing right. */
export function ChevronRightIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6.2 3.8L10.4 8l-4.2 4.2" />
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

/** Renders the close icon: a cross. */
export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
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

/** Renders the eye icon: an open eye with its pupil. */
export function EyeIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </IconFrame>
  );
}

/** Renders the file icon: a sheet with its corner folded. */
export function FileIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M4 2.4h5l3 3v8.2H4z" />
      <path d="M9 2.4v3h3" />
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

/** Renders the key icon: a ring and a bit with two teeth. */
export function KeyIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="5.4" cy="10.6" r="2.8" />
      <path d="M7.4 8.6l5.4-5.4M11 4.8l1.6 1.6M9.6 6.2l1.2 1.2" />
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

/** Renders the list icon: three lines, each after a filled dot. */
export function ListIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6 4.2h7.4M6 8h7.4M6 11.8h7.4" />
      <circle cx="3" cy="4.2" r=".5" fill="currentColor" />
      <circle cx="3" cy="8" r=".5" fill="currentColor" />
      <circle cx="3" cy="11.8" r=".5" fill="currentColor" />
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

/** Renders the pause icon: two upright bars. */
export function PauseIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M6 4v8M10 4v8" />
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

/** Renders the question icon: a question mark in a circle. */
export function QuestionIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="5.8" />
      <path d="M6.3 6.4a1.8 1.8 0 0 1 3.5.5c0 1.2-1.8 1.4-1.8 2.6" />
      <circle cx="8" cy="11.4" r=".4" fill="currentColor" />
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

/** Renders the server icon: two stacked units, each with a light. */
export function ServerIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="2.4" y="2.6" width="11.2" height="4.4" rx="1.4" />
      <rect x="2.4" y="9" width="11.2" height="4.4" rx="1.4" />
      <path d="M5 4.8h.1M5 11.2h.1" />
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

/** Renders the sparkle icon: a four-pointed star with curved sides. */
export function SparkleIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M8 2.4c.5 2.9 2.7 5.1 5.6 5.6-2.9.5-5.1 2.7-5.6 5.6-.5-2.9-2.7-5.1-5.6-5.6 2.9-.5 5.1-2.7 5.6-5.6z" />
    </IconFrame>
  );
}

/** Renders the stop icon: a filled square with rounded corners. */
export function StopIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <rect x="4.4" y="4.4" width="7.2" height="7.2" rx="1.6" fill="currentColor" stroke="none" />
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
