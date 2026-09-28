import type { JSX } from "react";
import { cn } from "../primitives/cn";

/** One answer, as the ledger shows it. */
export interface AnswerLedgerRow<Id extends string> {
  /** The answer's id, unique among the rows, passed to `onSelect` when the row is clicked. */
  readonly id: Id;
  readonly label: string;
  /** Whether this is the primary answer, whose label is in ink rather than muted. */
  readonly primary: boolean;
  /**
   * What clicking the row does, as parts. A `name` part is the name of
   * something the answer acts on, and is set apart in ink. The parts are
   * joined as they are, so the text parts carry the spaces between them.
   */
  readonly describeLine: ReadonlyArray<{ readonly kind: "text" | "name"; readonly text: string }>;
  /** Whether the answer runs nothing. Its describe line is then set in italics. */
  readonly runsNothing?: boolean;
  /** Fine print under the describe line, when there is any. */
  readonly description?: string | undefined;
}

/**
 * Renders the answers of a decision as a ledger (spec 14 §Answers as a
 * ledger): one full-width row per answer, and the row is the button. Each row
 * shows, in a fixed order:
 *
 * - the label in the left column, in ink for the primary answer and muted
 *   otherwise;
 * - the describe line at metadata size, which says what the click does, with
 *   names in ink;
 * - the description, when there is one, as fine print under it.
 *
 * Nothing is hidden behind a hover, so the user reads what each click does
 * before clicking. Hairlines separate the rows, and a hovered row gets the
 * soft background.
 *
 * Each row extends 8px past its column on both sides, so the hover background
 * has room around the label while the label stays on the left edge of the
 * text above the ledger.
 */
export function AnswerLedger<Id extends string>({
  rows,
  disabled,
  onSelect,
}: {
  readonly rows: ReadonlyArray<AnswerLedgerRow<Id>>;
  /** Whether every row refuses clicks, such as while an answer is being sent. */
  readonly disabled: boolean;
  /** Called with the id of the row the user clicked. */
  readonly onSelect: (id: Id) => void;
}): JSX.Element {
  return (
    <div className="flex flex-col divide-y divide-line-soft">
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(row.id)}
          className="-mx-2 grid grid-cols-[140px_minmax(0,1fr)] items-baseline gap-3 rounded-control px-2 py-[5px] text-left enabled:cursor-pointer enabled:hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
        >
          {/* Labels, names and descriptions can be long and may hold no
              spaces, such as a shell command or a path. They wrap at any
              character rather than push the row wider than its column. */}
          <span
            className={cn(
              "text-meta font-emph wrap-anywhere",
              row.primary ? "text-ink" : "text-muted",
            )}
          >
            {row.label}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className={cn("text-meta text-muted wrap-anywhere", row.runsNothing && "italic")}>
              {row.describeLine.map((part, index) =>
                part.kind === "name" ? (
                  // A name is isolated for bidirectional text, so a
                  // right-to-left mark inside it cannot reorder the words
                  // after it. It keeps its own line breaks, so a multi-line
                  // text reads as it was written.
                  <bdi key={index} className="whitespace-pre-wrap text-ink">
                    {part.text}
                  </bdi>
                ) : (
                  part.text
                ),
              )}
            </span>
            {/* `--muted`, not the spec's `--faint`: 12px `--faint` on
                `--surface` has a contrast of about 2.9:1 in dark mode and
                2.4:1 in light mode, too low for readable text. The smaller
                size keeps it below the describe line. The description is
                shown as plain text, not markdown, because a button may hold
                only inline content. */}
            {row.description === undefined ? null : (
              <span className="text-fine text-muted wrap-anywhere">{row.description}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
