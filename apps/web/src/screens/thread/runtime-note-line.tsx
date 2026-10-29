/**
 * A runtime error, warning or notice in the thread: something reported around the
 * agent's work, such as a harness that is not installed on the runner. It is a
 * quiet line, not a card: the mark and words carry the colour (design language
 * §Color doctrine), and nothing is filled.
 */
import { Fragment, type JSX } from "react";
import { MAX_UNBROKEN_CODE_WORD, splitCodeSpans, type RuntimeNote } from "@hercule/client-core";
import { FailedMark, cn } from "@hercule/ui";
import { INLINE_CODE } from "../markdown";

/**
 * The inline code of a message, for a command inside a runtime note. It is in the
 * ink colour, not the runtime note's hue, so the command to run reads clearly. It
 * has no vertical padding: the lines of a wrapped command are close, and with
 * it the chips of two lines would touch.
 */
const RUNTIME_NOTE_CODE = cn(INLINE_CODE, "py-0 text-ink");

/**
 * Draws the message of a runtime note. A command the runner wrote between backticks is
 * inline code. A word of the command stays whole, so the command wraps only at
 * its spaces and never inside a flag or an id. A word too long to always fit
 * a line, such as a path, is left as plain text in the code, so it breaks
 * anywhere and the chip covers every line of it.
 */
function RuntimeNoteMessage({ message }: { readonly message: string }): JSX.Element {
  return (
    <>
      {splitCodeSpans(message).map((part, index) =>
        part.kind === "code" ? (
          <code key={index} className={RUNTIME_NOTE_CODE}>
            {part.text.split(" ").map((word, wordIndex) => (
              <Fragment key={wordIndex}>
                {wordIndex === 0 ? null : " "}
                {word.length <= MAX_UNBROKEN_CODE_WORD ? (
                  <span className="whitespace-nowrap">{word}</span>
                ) : (
                  word
                )}
              </Fragment>
            ))}
          </code>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

/** The words a screen reader says before a note's message, by severity. */
const SEVERITY_LABEL: Record<RuntimeNote["severity"], string> = {
  error: "Error: ",
  warning: "Warning: ",
  notice: "Notice: ",
};

/**
 * Draws the mark of a runtime note, by severity:
 *
 * - An error has the failed mark.
 * - A warning has a filled muted dot.
 * - A notice has a hollow muted ring, the same size as the dot: a neutral note
 *   with nothing to act on, one step quieter than a warning.
 */
function RuntimeNoteMark({
  severity,
}: {
  readonly severity: RuntimeNote["severity"];
}): JSX.Element {
  switch (severity) {
    case "error":
      return <FailedMark />;
    case "warning":
      return <span className="size-1.5 rounded-full bg-current" />;
    case "notice":
      return <span className="size-1.5 rounded-full border border-current" />;
  }
}

/**
 * Draws one runtime note: a mark, then the message. An error has the failed mark
 * and the failure hue. A warning asks nothing of the user, so it is quieter:
 * a muted dot and muted words. A notice is quieter still, a neutral note with a
 * hollow ring. The text for a screen reader names the severity, because the mark
 * is decorative.
 */
export function RuntimeNoteLine({ note }: { readonly note: RuntimeNote }): JSX.Element {
  return (
    <div
      className={cn(
        "flex items-start gap-2 text-meta wrap-anywhere",
        note.severity === "error" ? "text-fail" : "text-muted",
      )}
    >
      {/* The box is one line high, so the mark stays centred on the first line of a message that wraps. */}
      <span className="flex h-lh w-3 shrink-0 items-center justify-center">
        <RuntimeNoteMark severity={note.severity} />
      </span>
      <p className="min-w-0">
        <span className="sr-only">{SEVERITY_LABEL[note.severity]}</span>
        <RuntimeNoteMessage message={note.message} />
      </p>
    </div>
  );
}
