import { useLayoutEffect, useRef, type JSX } from "react";

/** The height of one line of text at 14px/1.5, and the most lines the box grows to. */
const LINE_HEIGHT = 21;
const MAX_LINES = 8;

/**
 * The composer card's text field. It grows with the text from one line to
 * eight, and then scrolls. A composer that kept growing would push the thread
 * off the screen.
 */
export function MessageBox({
  value,
  placeholder,
  readOnly,
  onChange,
  onSubmit,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
}: {
  readonly value: string;
  readonly placeholder: string;
  /**
   * Whether the field takes no text. It keeps the focus and stays selectable,
   * and shows as faint and `aria-disabled`. A field that were `disabled` would
   * lose the focus and not get it back.
   */
  readonly readOnly: boolean;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  /** Called when the field loses focus. */
  readonly onBlur?: () => void;
  /** Called when an IME composition starts in the field. */
  readonly onCompositionStart?: (() => void) | undefined;
  /** Called when an IME composition in the field ends. */
  readonly onCompositionEnd?: (() => void) | undefined;
}): JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const field = ref.current;
    if (field === null) return;
    // Reset the height before measuring. `scrollHeight` is never less than
    // the current height, so without the reset a grown box would never shrink.
    field.style.height = "auto";
    field.style.height = `${String(Math.min(field.scrollHeight, MAX_LINES * LINE_HEIGHT))}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      readOnly={readOnly}
      aria-disabled={readOnly || undefined}
      placeholder={placeholder}
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onBlur={onBlur}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onKeyDown={(event) => {
        // Enter sends and Shift+Enter inserts a newline. The Enter that
        // commits an IME composition does not send, because treating it as
        // a send would cut off a Japanese or Chinese sentence mid-word. Most
        // browsers mark that Enter with `isComposing`. Safari does not: it
        // fires the keydown after the composition ends, with the legacy
        // `keyCode` 229 that means "the IME handled this key".
        if (event.key !== "Enter" || event.shiftKey) return;
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        onSubmit();
      }}
      className="block max-h-[168px] min-h-6 w-full resize-none overflow-y-auto bg-transparent text-body leading-[1.5] text-ink outline-none placeholder:text-faint read-only:cursor-default read-only:text-faint"
    />
  );
}
