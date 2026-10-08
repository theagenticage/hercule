import { useRef, type JSX } from "react";
import type { ModelPill } from "@hercule/client-core";
import { IMAGE_MIME_TYPES } from "@hercule/contract";
import { cn, ProviderLogo } from "@hercule/ui";

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
      onClick={onSend}
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink text-[13px] text-bg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live disabled:cursor-default disabled:bg-line disabled:text-faint"
    >
      <span aria-hidden="true">↑</span>
    </button>
  );
}

/**
 * Renders the model pill's content: the provider logo, the account when a
 * provider has two, and the model name.
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
      {pill.providerId === null ? null : <ProviderLogo providerId={pill.providerId} />}
      {pill.account === null ? null : (
        <span className="shrink-0 text-faint">{pill.account}</span>
      )}{" "}
      <span className="truncate">{pill.name ?? "No model"}</span>
    </span>
  );
}
