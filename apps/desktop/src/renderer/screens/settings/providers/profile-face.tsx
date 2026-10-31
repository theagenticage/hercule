import type { JSX } from "react";
import "./profile-face.css";

/**
 * Renders the face of a Model Profile: the first letter of its name on a
 * quiet disc, in the UI face. The profile tabs, and later the account cards,
 * draw a profile this way. `size` is `md` (22px), `sm` (18px, in a tab) or
 * `xs` (16px, overlapping others in a row). It is hidden from assistive
 * technology, because the name always stands beside it.
 */
export function ProfileFace({
  name,
  size = "md",
}: {
  readonly name: string;
  readonly size?: "md" | "sm" | "xs";
}): JSX.Element {
  const [initial = ""] = Array.from(name.trim());
  return (
    <span className={`profile-face profile-face--${size}`} aria-hidden="true">
      {initial.toLocaleUpperCase()}
    </span>
  );
}
