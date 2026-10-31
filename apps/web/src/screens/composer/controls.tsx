import { useRef, type JSX } from "react";
import { PREVIOUS_QUESTION_LABEL, type ModelPill } from "@hercule/client-core";
import { IMAGE_MIME_TYPES } from "@hercule/contract";
import { cn, HarnessLogo } from "@hercule/ui";

const GLYPH =
  "inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-muted";

/**
 * The attach button: opens the file picker for PNG, JPEG, GIF and WebP
 * images, several at once, and calls `onFiles` with the files picked. Like
 * every button in this file, it holds no state and knows no domain.
 */
export function AttachButton({
  disabledReason,
  onFiles,
}: {
  /** Why no image can be attached, shown as the tooltip; `null` when the button works. */
  readonly disabledReason: string | null;
  readonly onFiles: (files: readonly File[]) => void;
}): JSX.Element {
  const picker = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabledReason !== null}
        title={disabledReason ?? "Attach images"}
        aria-label="Attach images"
        onClick={() => picker.current?.click()}
        className={cn(
          GLYPH,
          "cursor-pointer text-[17px] enabled:hover:bg-line-soft enabled:hover:text-ink disabled:cursor-default disabled:text-faint",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        )}
      >
        +
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        accept={IMAGE_MIME_TYPES.join(",")}
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])]);
          // Cleared so picking the same file again still reports a change.
          event.target.value = "";
        }}
      />
    </>
  );
}

/** The dictation button. It stays disabled until dictation is built. */
export function VoiceButton(): JSX.Element {
  return (
    <button
      type="button"
      disabled
      title="Dictation is not built yet"
      aria-label="Voice"
      className={cn(GLYPH, "size-7 rounded-full")}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        className="size-4"
      >
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
      </svg>
    </button>
  );
}

/**
 * The button that sends the message. Pressing the mouse on it does not take
 * the focus from the message field. Taking it would end the typing guard
 * (see `useTypingGuard`), a question could then take the composer over, and
 * this button would be replaced before the click that the user aimed at it
 * arrived. The keyboard is not affected: the button is still a tab stop.
 */
export function SendButton({
  tip,
  disabled,
  onSend,
}: {
  /** The tooltip: what sending does here, with its shortcut, such as "Start thread ⏎". */
  readonly tip: string;
  readonly disabled: boolean;
  readonly onSend: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Send"
      title={tip}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onSend}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink text-[13px] text-bg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live disabled:cursor-default disabled:bg-line disabled:text-faint"
    >
      <span aria-hidden="true">↑</span>
    </button>
  );
}

/**
 * The button that replaces Send while the composer answers a question: Next,
 * or Send answers on the last question. It is as tall as the Send button and
 * has the same colours, so the composer's right edge stays where it is.
 *
 * While `disabled` the button is `aria-disabled` rather than `disabled` and
 * ignores clicks, so it keeps the focus: Next on an unanswered question
 * leaves the focus where it was.
 */
export function StepButton({
  label,
  disabled,
  onStep,
}: {
  /** "Next" or "Send answers". */
  readonly label: string;
  readonly disabled: boolean;
  readonly onStep: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={`${label} ⏎`}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onStep}
      className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full bg-ink px-3 text-meta leading-[18px] font-emph text-bg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live aria-disabled:cursor-default aria-disabled:bg-line aria-disabled:text-faint"
    >
      {label}
    </button>
  );
}

/**
 * The button that shows the question before the shown one. Quiet, as it is
 * not the main action. Like `StepButton`, it is `aria-disabled` while
 * `disabled`.
 */
export function PreviousButton({
  disabled,
  onPrevious,
}: {
  readonly disabled: boolean;
  readonly onPrevious: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onPrevious}
      className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full px-2.5 text-meta leading-[18px] font-emph text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live not-aria-disabled:hover:bg-line-soft not-aria-disabled:hover:text-ink aria-disabled:cursor-default aria-disabled:text-faint"
    >
      {PREVIOUS_QUESTION_LABEL}
    </button>
  );
}

/**
 * Renders the model pill's content: the harness logo, the account when a
 * provider has two, the model name, and "in pi" when the thread runs in a
 * harness other than the account's default.
 *
 * The parts are laid out as a flex row rather than inline text, because the
 * logo is an `svg` block and a block inside inline text breaks the line. Only
 * the name may be truncated: a model called `Default (recommended)` gets an
 * ellipsis, so the pill always stays one line high and the controls beside it
 * do not move. Spec 14 §Measurements sets the pill's size.
 */
export function PillLabel({ pill }: { readonly pill: ModelPill }): JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {pill.harnessId === null ? null : <HarnessLogo harnessId={pill.harnessId} />}
      {pill.account === null ? null : (
        <span className="shrink-0 text-faint">{pill.account}</span>
      )}{" "}
      <span className="truncate">{pill.name ?? "No model"}</span>
      {pill.inHarness === null ? null : (
        <>
          {" "}
          <span className="shrink-0 text-faint">in {pill.inHarness}</span>
        </>
      )}
    </span>
  );
}
