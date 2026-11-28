import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ReasonPhrase, ThreadStarter } from "@hercule/client-core/inbox";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { isPrimaryModifierHeld } from "../../app/primary-modifier";
import { Face, type Look } from "../../faces";
import { CloseIcon } from "../../icons/close";
import { InfoIcon } from "../../icons/info";
import { GlassDialog } from "../glass-dialog";
import "../new-thread/new-thread.css";
import "../session/composer.css";
import {
  playDialogClosing,
  playDialogOpening,
  playThreadStarting,
  type WritingSnapshot,
} from "./thread-dialog-motion";
import "./thread-dialog.css";

/** The size of the face in the dialog's header, in pixels. */
const FACE_SIZE = 28;

/** One starter chip: the starter and the words on the chip. */
export interface StarterChip {
  readonly starter: ThreadStarter;
  readonly label: string;
}

/** What the dialog shows while the user writes the message. */
export interface WritingPhase {
  readonly kind: "writing";
  /** The name the new Task gets. The header edits it. */
  readonly title: string;
  readonly starters: readonly StarterChip[];
  readonly chosenStarter: ThreadStarter;
  /** The composer, with the thing chips above its field and the project pick in its lip. */
  readonly composer: ReactNode;
  /** The sentence under the composer that says why the defaults are what they are. */
  readonly reason: readonly ReasonPhrase[];
  readonly onTitleChange: (title: string) => void;
  readonly onPickStarter: (starter: ThreadStarter) => void;
  /** Called by ⌘↩ (Ctrl+↩ off macOS), the key that sends the message. */
  readonly onStart: () => void;
}

/** What the dialog shows once the thread has started. */
export interface StartedPhase {
  readonly kind: "started";
  /** The Task's name, which can no longer be edited. */
  readonly title: string;
  /** The line under the name, such as "Thread started · webshop · Opus 5.5 · High". */
  readonly summary: string;
  /** The thread's first moments. Mark the user's first message with `data-first-message` so it can rise from the composer. */
  readonly transcript: ReactNode;
  /** The note in the footer, such as "It is on this Task now". */
  readonly note: string;
  readonly onOpenThread: () => void;
}

/**
 * Renders the dialog that starts a thread from things in the Inbox. It looks
 * like a thread before it is one. `phase` is one of two states:
 *
 * - writing: the Task's name in the header, the starters as chips, the
 *   composer, and the reason under it. ⌘↩ (Ctrl+↩ off macOS, by `platform`)
 *   calls `onStart`.
 * - started: the header with the face at work, the transcript in a scrolling
 *   body, and a footer with "Back to the Inbox" and "Open the thread", which
 *   has the focus. ↩ anywhere but on a button calls `onOpenThread`.
 *
 * The dialog is modal and Tab stays inside it. Esc closes an open menu first,
 * and only then the dialog; so do the close button, "Back to the Inbox" and a
 * click on the scrim. The dialog plays its closing motion and stays modal
 * until it ends, and then calls `onClose` once. The caller then unmounts it.
 * The dialog's height springs when the phase changes from writing to started.
 *
 * `look` is the face the header draws.
 */
export function ThreadDialog({
  phase,
  look,
  platform,
  onClose,
}: {
  readonly phase: WritingPhase | StartedPhase;
  readonly look: Look;
  readonly platform: DesktopPlatform;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const writingSnapshotRef = useRef<WritingSnapshot | null>(null);
  const closingRef = useRef(false);
  const reportedRef = useRef(false);
  const started = phase.kind === "started";

  /** Calls `onClose` once, however the dialog came to be closed. */
  const reportClosed = useCallback((): void => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    onClose();
  }, [onClose]);

  /** Plays the closing motion, then closes the dialog. A second request while it plays does nothing. */
  const requestClose = useCallback((): void => {
    const dialog = dialogRef.current;
    if (closingRef.current || dialog === null) return;
    closingRef.current = true;
    playDialogClosing(dialog, () => {
      if (dialog.open) dialog.close();
      reportClosed();
    });
  }, [reportClosed]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    playDialogOpening(dialog);
    // Which element a modal dialog focuses when it opens differs between browser versions.
    dialog.querySelector<HTMLElement>(".composer-input")?.focus({ preventScroll: true });
  }, []);

  /**
   * Ref for the writing body. React calls the returned function when the
   * body leaves, after the phase changed but before its element is removed, so
   * the dialog is measured once, as the writing last looked, and not on every
   * render.
   */
  const attachWritingBody = useCallback((body: HTMLDivElement): (() => void) => {
    return () => {
      const dialog = dialogRef.current;
      const card = body.querySelector(".composer-card");
      if (dialog === null || card === null) return;
      writingSnapshotRef.current = {
        height: dialog.offsetHeight,
        composerTop: card.getBoundingClientRect().top - dialog.getBoundingClientRect().top,
      };
    };
  }, []);

  useLayoutEffect(() => {
    if (!started) return;
    openButtonRef.current?.focus({ preventScroll: true });
    const dialog = dialogRef.current;
    const body = bodyRef.current;
    const before = writingSnapshotRef.current;
    writingSnapshotRef.current = null;
    if (dialog !== null && body !== null && before !== null)
      playThreadStarting(dialog, body, before);
  }, [started]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    // The composer's field starts a thread on its own ⌘↩ and marks the event handled.
    if (event.key !== "Enter" || event.defaultPrevented) return;
    if (phase.kind === "writing") {
      if (!isPrimaryModifierHeld(event, platform)) return;
      // The page sees a shortcut before the dialog does; a handled one never reaches the app's menu.
      event.preventDefault();
      phase.onStart();
      return;
    }
    // ↩ on a button is that button's.
    if (event.target instanceof Element && event.target.closest("button") !== null) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    phase.onOpenThread();
  };

  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="thread-dialog"
      label={started ? "Thread started" : "Start a thread"}
      onClose={reportClosed}
      onCloseRequest={requestClose}
      onKeyDown={handleKeyDown}
    >
      <header className="thread-dialog-head">
        <span className="thread-dialog-face">
          <Face look={look} pose={started ? "working" : "idle"} size={FACE_SIZE} />
        </span>
        <div className="thread-dialog-name">
          {phase.kind === "writing" ? (
            <input
              className="thread-dialog-title"
              value={phase.title}
              aria-label="The Task’s name"
              onChange={(event) => {
                phase.onTitleChange(event.target.value);
              }}
            />
          ) : (
            <p className="thread-dialog-title thread-dialog-title--fixed">{phase.title}</p>
          )}
          <span className="thread-dialog-sub">
            {phase.kind === "writing" ? "A new Task on Work, with a thread on it" : phase.summary}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn"
          title="Close (Esc)"
          aria-label="Close"
          onClick={requestClose}
        >
          <CloseIcon />
        </button>
      </header>
      {phase.kind === "writing" ? (
        <div ref={attachWritingBody} className="thread-dialog-body">
          <div className="thread-dialog-starters" role="radiogroup" aria-label="Start from">
            {phase.starters.map(({ starter, label }) => (
              <StarterButton
                key={starter}
                label={label}
                checked={starter === phase.chosenStarter}
                onPick={() => {
                  phase.onPickStarter(starter);
                }}
              />
            ))}
          </div>
          {phase.composer}
          <p className="thread-dialog-why">
            <InfoIcon size={14} />
            <span>
              {phase.reason.map((part, index) =>
                part.strong === true ? <b key={index}>{part.text}</b> : part.text,
              )}
            </span>
          </p>
        </div>
      ) : (
        <>
          <div ref={bodyRef} className="thread-dialog-body thread-dialog-body--started">
            {phase.transcript}
          </div>
          <footer className="thread-dialog-foot">
            <span className="thread-dialog-note">{phase.note}</span>
            <span className="spacer" />
            <button
              type="button"
              className="btn btn--quiet"
              aria-keyshortcuts="Escape"
              onClick={requestClose}
            >
              Back to the Inbox
              <kbd aria-hidden="true">Esc</kbd>
            </button>
            <button
              ref={openButtonRef}
              type="button"
              className="btn btn--accent"
              aria-keyshortcuts="Enter"
              onClick={phase.onOpenThread}
            >
              Open the thread
              <kbd aria-hidden="true">↩</kbd>
            </button>
          </footer>
        </>
      )}
    </GlassDialog>
  );
}

/**
 * Renders one starter as a radio. Only the checked one is in the Tab order,
 * and the arrow keys move the focus between the radios without picking: a
 * pick replaces the message, so Space or ↩ makes it.
 */
function StarterButton({
  label,
  checked,
  onPick,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onPick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      tabIndex={checked ? 0 : -1}
      className="thread-dialog-starter"
      onClick={onPick}
      onKeyDown={(event) => {
        const step =
          event.key === "ArrowRight" || event.key === "ArrowDown"
            ? 1
            : event.key === "ArrowLeft" || event.key === "ArrowUp"
              ? -1
              : 0;
        if (step === 0) return;
        event.preventDefault();
        const radios = [
          ...(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>("[role=radio]") ??
            []),
        ];
        const next =
          radios[(radios.indexOf(event.currentTarget) + step + radios.length) % radios.length];
        next?.focus();
      }}
    >
      {label}
    </button>
  );
}
