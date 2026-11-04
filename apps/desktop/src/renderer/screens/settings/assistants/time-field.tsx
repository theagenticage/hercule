import type { JSX } from "react";
import { useTextDraft } from "../use-text-draft";
import type { DesktopPlatform } from "../../../../ipc/platform/desktop-platform";

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
  platform,
}: {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (text: string) => void;
  /** The platform the app runs on, which decides the key that commits with ⏎: ⌘ on a Mac, Ctrl on Linux. */
  readonly platform: DesktopPlatform;
}): JSX.Element {
  const draft = useTextDraft(platform, value, (text) => {
    onCommit(text.trim());
  });
  return (
    <input className="field" aria-label={label} inputMode="numeric" spellCheck={false} {...draft} />
  );
}
