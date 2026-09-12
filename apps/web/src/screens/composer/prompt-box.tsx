import { useLayoutEffect, useRef, type JSX } from "react";

/** One line of text at 14px/1.5, and the eight the box grows to at most. */
const LINE_HEIGHT = 21;
const MAX_LINES = 8;

/**
 * The card's own field. It grows with what is typed, from one line to eight,
 * and then scrolls: a composer that keeps growing would push the thread it is
 * about off the screen.
 */
export function PromptBox({
  value,
  placeholder,
  disabled,
  onChange,
  onSubmit,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const field = ref.current;
    if (field === null) return;
    // Measured from scratch: the height just set is itself a floor on
    // `scrollHeight`, so a box that has grown would never shrink again.
    field.style.height = "auto";
    field.style.height = `${String(Math.min(field.scrollHeight, MAX_LINES * LINE_HEIGHT))}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onKeyDown={(event) => {
        // Enter sends, Shift+Enter is a newline. An IME's own Enter - the one
        // that commits a composition - is not a send: React reports it as
        // `isComposing`, and swallowing it would cut a Japanese or Chinese
        // sentence off mid-word.
        if (event.key !== "Enter" || event.shiftKey) return;
        if (event.nativeEvent.isComposing) return;
        event.preventDefault();
        onSubmit();
      }}
      className="block max-h-[168px] w-full resize-none overflow-y-auto bg-transparent text-body leading-relaxed text-ink outline-none placeholder:text-faint disabled:text-faint"
    />
  );
}
