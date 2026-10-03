/**
 * PROTOTYPE - the icons the office's panels draw that the app's icon set does
 * not have yet. Each path is the Bureau book's, from its crew.js, on the same
 * 16-unit frame as every app icon.
 */
import type { JSX } from "react";
import { IconFrame, type IconProps } from "../../../icons";

/** Renders the office: a house with a door. */
export function OfficeIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <IconFrame size={size}>
      <path d="M2.4 13.6h11.2M3.6 13.6V6.4L8 3l4.4 3.4v7.2" />
      <path d="M6.4 13.6v-3.4h3.2v3.4" />
    </IconFrame>
  );
}

/** Renders a list: three bullets with their lines. */
export function ListIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <IconFrame size={size}>
      <path d="M6 4.2h7.4M6 8h7.4M6 11.8h7.4" />
      <circle cx="3" cy="4.2" r=".5" />
      <circle cx="3" cy="8" r=".5" />
      <circle cx="3" cy="11.8" r=".5" />
    </IconFrame>
  );
}

/** Renders a cross, for closing a panel. */
export function CloseIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <IconFrame size={size}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </IconFrame>
  );
}

/** Renders a lightning bolt, for the Simulate menu. */
export function BoltIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <IconFrame size={size}>
      <path d="M8.8 2L4 9h3.6L7 14l5-7H8.4z" />
    </IconFrame>
  );
}

/** Renders a chevron that points down, for a button that opens a menu. */
export function ChevronDownIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <IconFrame size={size}>
      <path d="M3.8 6.2L8 10.4l4.2-4.2" />
    </IconFrame>
  );
}

/**
 * Renders a small Z, for a colleague that is asleep or away. Those two poses
 * have no state mark, and the moon is already idle's mark.
 */
export function SleepIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <IconFrame size={size}>
      <path d="M5.2 5.2h5.6l-5.6 5.6h5.6" />
    </IconFrame>
  );
}

/** Renders a chip, for the performance readout. */
export function CpuIcon({ size = 16 }: IconProps): JSX.Element {
  return (
    <IconFrame size={size}>
      <rect x="4" y="4" width="8" height="8" rx="1.6" />
      <path d="M6.4 1.8V4M9.6 1.8V4M6.4 12v2.2M9.6 12v2.2M1.8 6.4H4M1.8 9.6H4M12 6.4h2.2M12 9.6h2.2" />
    </IconFrame>
  );
}
