import type { JSX, ReactNode } from "react";
import { CheckIcon } from "../../icons/check";
import { ChevronRightIcon } from "../../icons/chevron-right";

/**
 * Renders one row of a composer menu: the name, up to two lines under it, a
 * note at the right, and a check on the current row.
 *
 * - `glyph` is drawn before the name, such as the logo of a model's provider.
 * - `detail` follows the name on its line, after " · ", in the row's muted ink.
 * - `sub` is the line under the name that explains the row.
 * - `warning` is a second line, in the attention hue, for what the user
 *   should know before picking the row.
 * - `chevron` ends the row with a chevron, for a row that stands for more
 *   than one choice, such as an account and its models.
 * - `inert` draws the row faded and not as a button, for a row that cannot
 *   be picked. Its reason is in `note` or `sub`, because a row is "dimmed
 *   with the reason, never hidden" (spec 14 §The composer).
 */
export function MenuLine({
  glyph = null,
  name,
  detail = null,
  sub = null,
  warning = null,
  note = null,
  current,
  chevron = false,
  inert = false,
  onPick,
}: {
  readonly glyph?: ReactNode;
  readonly name: string;
  readonly detail?: string | null;
  readonly sub?: string | null;
  readonly warning?: string | null;
  readonly note?: ReactNode;
  readonly current: boolean;
  readonly chevron?: boolean;
  readonly inert?: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  const body = (
    <>
      {glyph}
      <span className="grow">
        <b>{name}</b>
        {detail === null ? null : ` · ${detail}`}
        {sub === null || sub === "" ? null : <small>{sub}</small>}
        {warning === null ? null : <small className="line-warning">{warning}</small>}
      </span>
      {note === null ? null : <span className="line-note">{note}</span>}
      {current ? <CheckIcon size={14} /> : null}
      {chevron ? <ChevronRightIcon size={13} /> : null}
    </>
  );
  if (inert) return <div className="line line--dimmed">{body}</div>;
  return (
    <button type="button" className="line" aria-current={current || undefined} onClick={onPick}>
      {body}
    </button>
  );
}
