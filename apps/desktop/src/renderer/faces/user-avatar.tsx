import type { JSX } from "react";
import "./face.css";

/**
 * Renders the user's own avatar, `size` CSS pixels square: the first
 * character of `name`, upper-cased, on a `--you` circle. People are drawn as
 * a letter, not as a face. The accessible name is `name`; a `decorative`
 * avatar is hidden from assistive technology instead, for a place where the
 * name is written beside it.
 *
 * The markup is the Bureau book's `you` in crew.js, which hard-codes "R" and
 * "Rogier".
 */
export function UserAvatar({
  name,
  size,
  decorative = false,
}: {
  readonly name: string;
  readonly size: number;
  readonly decorative?: boolean;
}): JSX.Element {
  // Destructuring takes the first code point, so a name that starts with an
  // emoji or another character outside the BMP keeps it whole.
  const [firstCharacter = ""] = name;
  const accessibility = decorative ? { "aria-hidden": true } : { role: "img", "aria-label": name };
  return (
    <svg className="cr-you" viewBox="0 0 32 32" width={size} height={size} {...accessibility}>
      <circle cx="16" cy="16" r="15" fill="var(--you)" />
      <circle cx="16" cy="16" r="15" fill="none" stroke="oklch(0 0 0 / .08)" />
      <text
        x="16"
        y="21.2"
        textAnchor="middle"
        fontFamily="var(--font-ui)"
        fontSize="15"
        fontWeight="700"
        fill="var(--face-ink)"
      >
        {firstCharacter.toUpperCase()}
      </text>
    </svg>
  );
}
