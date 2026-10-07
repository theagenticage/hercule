import type { JSX } from "react";
import { useTextDraft } from "../use-text-draft";

/**
 * Renders a time of day as the Bureau book's small `.field`, such as
 * "07:00", in a sentence of controls.
 *
 * The text typed saves as `useTextDraft` describes. `onCommit` receives it
 * without spaces around it. The field then shows `value` again: the saved
 * value, or the new one once the caller saves it, so a time the caller
 * refuses reverts on its own.
 */
export function TimeField({
  label,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (text: string) => void;
}): JSX.Element {
  const draft = useTextDraft(value, (text) => {
    onCommit(text.trim());
  });
  return (
    <input className="field" aria-label={label} inputMode="numeric" spellCheck={false} {...draft} />
  );
}
