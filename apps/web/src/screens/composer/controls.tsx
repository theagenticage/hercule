import type { JSX } from "react";
import { cn } from "@hydra/ui";

const GLYPH =
  "inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-faint";

/** The card row's plain controls: no domain, no state, one job each. */
export function AttachButton(): JSX.Element {
  return (
    <button
      type="button"
      disabled
      title="attachments are not built"
      aria-label="Attach"
      className={cn(GLYPH, "text-[17px]")}
    >
      +
    </button>
  );
}

export function VoiceButton(): JSX.Element {
  return (
    <button
      type="button"
      disabled
      title="dictation is not built"
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

export function StopButton({ onStop }: { readonly onStop: () => void }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onStop}
      title="Stops the running turn; queued messages wait"
      className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-meta font-emph text-ink hover:bg-line-soft"
    >
      <span aria-hidden="true" className="size-2 rounded-[1.5px] bg-current" />
      Stop
    </button>
  );
}

export function SendButton({
  tip,
  disabled,
  onSend,
}: {
  /** What sending does here, as the shortcut says it: "Start thread ⏎". */
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
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink text-meta text-bg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live disabled:cursor-default disabled:bg-line disabled:text-faint"
    >
      <span aria-hidden="true">↑</span>
    </button>
  );
}

/** The card's own word that a pick has not gone anywhere yet. */
export function PendingNote({ note }: { readonly note: string }): JSX.Element {
  return <span className="ml-1 font-mono text-[11px] text-attn">{note}</span>;
}
