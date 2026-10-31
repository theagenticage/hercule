import type { JSX, ReactNode } from "react";
import { CheckIcon } from "../../icons/check";
import { ChevronRightIcon } from "../../icons/chevron-right";

/**
 * Renders one row of a composer menu: the name, up to two lines under it, a
 * note at the right, and a check on the current row.
 *
 * - `glyph` is drawn before the name, such as the logo of a model's harness.
 * - `detail` follows the name on its line, after " · ", in the row's muted ink.
 * - `sub` is the line under the name that explains the row.
 * - `warning` is a second line, in the attention hue, for what the user
 *   should know before picking the row.
 * - `chevron` ends the row with a chevron, for a row that stands for more
 *   than one choice, such as an account and its models.
 * - `multiple` marks a row that is one of several that can be on at once, such
 *   as a model in a list of models to hold. It reports its state as pressed
 *   rather than as the current choice.
 * - `inert` draws the row faded and not as a button, for a row that cannot
 *   be picked. Its reason is in `note` or `sub`, because a row is "dimmed
 *   with the reason, never hidden" (spec 14 §The composer).
 * - `entryKey` names the entry the row stands for (`formatProfileEntryKey`),
 *   in a `data-entry-key` attribute, so that code that moves the focus can
 *   find the row without reading its text.
 * - `action` is a link at the right of an inert row that fixes the reason,
 *   such as Sign in. It stays at full strength while the rest of the row is
 *   faded. Only an inert row has one.
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
  multiple = false,
  inert = false,
  entryKey,
  action = null,
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
  readonly multiple?: boolean;
  readonly inert?: boolean;
  readonly entryKey?: string | undefined;
  readonly action?: { readonly label: string; readonly onAct: () => void } | null;
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
  if (inert) {
    return (
      <div
        className={action === null ? "line line--dimmed" : "line line--dimmed line--acting"}
        data-entry-key={entryKey}
      >
        {body}
        {action === null ? null : (
          <button type="button" className="link line-action" onClick={action.onAct}>
            {action.label}
          </button>
        )}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="line"
      data-entry-key={entryKey}
      aria-current={multiple ? undefined : current || undefined}
      aria-pressed={multiple ? current : undefined}
      onClick={onPick}
    >
      {body}
    </button>
  );
}
