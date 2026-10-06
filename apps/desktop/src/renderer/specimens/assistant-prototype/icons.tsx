/**
 * PROTOTYPE (#448). The icons the assistant page draws that the app has not
 * needed yet, copied from the Bureau book's crew.js. Promoted to icons/, one
 * module each, when the page is built for real.
 */
import type { JSX } from "react";
import { IconFrame, type IconProps } from "../../icons/icon-frame";
import { BrandMark } from "../../logos/brand-mark";

export function HeartIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.2 8.2h2.6l1.4-3 2.2 6 1.6-3.4h3.8" />
    </IconFrame>
  );
}

export function MemoryIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M3.4 2.8h7.4a1.8 1.8 0 0 1 1.8 1.8v8.6H5.2a1.8 1.8 0 0 1-1.8-1.8z" />
      <path d="M3.4 11.4a1.8 1.8 0 0 1 1.8-1.8h7.4M6 5.4h4" />
    </IconFrame>
  );
}

export function AlarmIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8.8" r="4.8" />
      <path d="M8 6.6v2.4l1.6 1M2.6 3.6l1.8-1.4M13.4 3.6l-1.8-1.4" />
    </IconFrame>
  );
}

export function ChatIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <path d="M2.4 8a5.6 5 0 1 1 2.4 4.1L2.4 13l.7-2.4A4.8 4.8 0 0 1 2.4 8z" />
    </IconFrame>
  );
}

export function SettingsIcon(props: IconProps): JSX.Element {
  return (
    <IconFrame {...props}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.9v1.6M8 12.5v1.6M1.9 8h1.6M12.5 8h1.6M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M3.7 12.3l1.1-1.1M11.2 4.8l1.1-1.1" />
    </IconFrame>
  );
}

const SLACK_PATH =
  "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z";

export function SlackMark({ size }: { readonly size: number }): JSX.Element {
  return <BrandMark path={SLACK_PATH} size={size} />;
}
