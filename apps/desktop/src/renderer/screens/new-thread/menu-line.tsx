import type { JSX, ReactNode } from "react";
import { CheckIcon } from "../../icons";

/**
 * Renders one row of a Draft Thread's menu: the name, up to two lines under
 * it, a note at the right, and a check on the current row.
 *
 * - `sub` is the line under the name that explains the row.
 * - `warning` is a second line, in the attention hue, for what the user
 *   should know before picking the row.
 * - `inert` draws the row faded and not as a button, for a row that cannot
 *   be picked. Its reason is in `note` or `sub`, because a row is "dimmed
 *   with the reason, never hidden" (spec 14 §The composer).
 */
export function MenuLine({
  name,
  sub = null,
  warning = null,
  note = null,
  current,
  inert = false,
  onPick,
}: {
  readonly name: string;
  readonly sub?: string | null;
  readonly warning?: string | null;
  readonly note?: ReactNode;
  readonly current: boolean;
  readonly inert?: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  const body = (
    <>
      <span className="grow">
        <b>{name}</b>
        {sub === null || sub === "" ? null : <small>{sub}</small>}
        {warning === null ? null : <small className="line-warning">{warning}</small>}
      </span>
      {note === null ? null : <span className="line-note">{note}</span>}
      {current ? <CheckIcon size={14} /> : null}
    </>
  );
  if (inert) return <div className="line line--dimmed">{body}</div>;
  return (
    <button type="button" className="line" aria-current={current || undefined} onClick={onPick}>
      {body}
    </button>
  );
}
