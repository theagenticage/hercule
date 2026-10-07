import { useState, type ChangeEvent, type KeyboardEvent } from "react";

/** The props `useTextDraft` returns for a text input or a textarea. */
export interface TextDraftProps {
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
}

/**
 * Returns the props of a text input or textarea that edits `stored` (spec 17
 * §Settings, The frame, Saving). The text typed is kept in the control until
 * the user commits it; then `onCommit` receives it, unless it is still
 * `stored`, and the control shows `stored` again: the saved value, or the
 * new one once the caller saves it. So text the caller refuses reverts on
 * its own.
 *
 * - Leaving the control commits.
 * - Cmd+Enter commits and leaves the control.
 * - Enter commits in a one-line input, which has no other use for it.
 * - Esc drops the typed text and shows `stored` again.
 */
export function useTextDraft(stored: string, onCommit: (text: string) => void): TextDraftProps {
  // The text being typed, or null while the control shows `stored`.
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== stored) onCommit(draft);
  };
  return {
    value: draft ?? stored,
    onChange: (event) => {
      setDraft(event.target.value);
    },
    onBlur: commit,
    onKeyDown: (event) => {
      if (event.key === "Escape") {
        setDraft(null);
      } else if (event.key === "Enter" && event.metaKey) {
        event.preventDefault();
        // Leaving the control commits the text, so committing here as well
        // would save it twice.
        event.currentTarget.blur();
      } else if (event.key === "Enter" && event.currentTarget instanceof HTMLInputElement) {
        event.preventDefault();
        commit();
      }
    },
  };
}
