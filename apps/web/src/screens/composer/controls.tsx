import type { JSX } from "react";
import type { ModelPill } from "@hydra/client-core";
import { cn, ProviderLogo } from "@hydra/ui";

const GLYPH =
  "inline-flex size-[26px] shrink-0 items-center justify-center rounded-[7px] text-muted";

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
      className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ink text-[13px] text-bg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live disabled:cursor-default disabled:bg-line disabled:text-faint"
    >
      <span aria-hidden="true">↑</span>
    </button>
  );
}

/**
 * The pill's face: the mark, the account where a provider has two, the model.
 *
 * A row of its own rather than three things in a line of text: the mark is an
 * `svg`, which is a block, and a block in a line of text breaks it. The name
 * is the only part that may be clipped - a model called `Default
 * (recommended)` is cut with an ellipsis rather than growing the pill a second
 * line (spec 14 §Measurements, the pill holds still).
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
