import type { JSX, ReactNode } from "react";
import { cn } from "@hercule/ui";

/**
 * One row of a composer menu. From left to right it has:
 *
 * - a marker column: a dot on the current row, or a provider's logo;
 * - the name, with its small detail beside it;
 * - a note on the right.
 *
 * An optional sub-line sits below the name and the note.
 *
 * A dimmed row is not a button. Spec 14 §The composer says a row is "dimmed
 * with the reason, never hidden", so the row stays visible but does nothing
 * when clicked. The one control it may still have, a login, sits in the
 * trailing slot as a separate button, because a button cannot be nested
 * inside another button.
 */
export function MenuRow({
  marker,
  name,
  detail,
  note,
  sub,
  current = false,
  dimmed = null,
  clipNote = false,
  inert,
  trailing,
  className,
  onPick,
}: {
  /** The content of the marker column; defaults to the row's dot. */
  readonly marker?: ReactNode;
  readonly name: ReactNode;
  /** The small word beside the name: an account, a plan, "default". */
  readonly detail?: string | null;
  readonly note?: ReactNode;
  readonly sub?: ReactNode;
  readonly current?: boolean;
  readonly dimmed?: string | null;
  /**
   * Whether the right-hand note is truncated, instead of the name, when the
   * row is too narrow. A branch name is what the user picks, so it must stay
   * whole; the note about what holds the branch is less important.
   */
  readonly clipNote?: boolean;
  /**
   * Whether the row cannot be picked, for a row that shows its reason
   * somewhere other than the right-hand note, such as on its sub-line. A row
   * with a `dimmed` reason is already inert without this flag.
   */
  readonly inert?: boolean;
  readonly trailing?: ReactNode;
  /** Extra classes for the row, such as a rule above it. */
  readonly className?: string;
  readonly onPick?: () => void;
}): JSX.Element {
  const body = (
    <>
      {marker ?? (
        <span aria-hidden="true" className="flex w-2.5 justify-center">
          <span className={cn("size-[5px] rounded-full", current && "bg-ink")} />
        </span>
      )}
      <span className={cn(clipNote ? "whitespace-nowrap" : "min-w-0 truncate")}>
        {name}
        {detail === undefined || detail === null || detail === "" ? null : (
          <span className="ml-1.5 text-[11px] font-normal text-faint">{detail}</span>
        )}
      </span>{" "}
      <span
        className={cn(
          "flex items-center gap-1.5 text-[11px] font-normal",
          // The note stays aligned to the row's right edge in both layouts. On
          // a `clipNote` row the note is the wide column, so its contents are
          // pushed right rather than left next to the name.
          clipNote ? "min-w-0 justify-end text-right" : "shrink-0 whitespace-nowrap",
          marker !== undefined && current ? "text-ink" : "text-faint",
        )}
      >
        {note}
        {note !== undefined && note !== null && dimmed !== null ? <span>·</span> : null}
        {clipNote && typeof dimmed === "string" ? (
          // Truncated, with the full text as the tooltip so the clipped part
          // can still be read.
          <span title={dimmed} className="min-w-0 truncate">
            {dimmed}
          </span>
        ) : (
          dimmed
        )}
        {trailing === undefined || trailing === null ? null : <span>·</span>}
        {trailing}
      </span>
      {sub === undefined || sub === null ? null : (
        <span className="col-start-2 col-end-4 truncate text-[11px] font-normal text-faint">
          {sub}
        </span>
      )}
    </>
  );

  const layout = cn(
    "grid w-full items-center gap-x-2 rounded-[6px]",
    // Only the flexible column shrinks: the name by default, or the note when
    // the name must stay whole.
    clipNote ? "grid-cols-[auto_auto_minmax(0,1fr)]" : "grid-cols-[auto_minmax(0,1fr)_auto]",
    // A row with a marker is a model row: slightly taller, and in ink.
    marker === undefined ? "px-2 py-[5px]" : "px-2 py-1.5",
    "text-left text-meta",
    current && "font-emph",
    current || (marker !== undefined && dimmed === null) ? "text-ink" : "text-muted",
    className,
  );

  if (inert ?? dimmed !== null) {
    return <div className={cn(layout, "opacity-50")}>{body}</div>;
  }

  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onPick}
      className={cn(
        layout,
        "cursor-pointer hover:bg-line-soft hover:text-ink",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
      )}
    >
      {body}
    </button>
  );
}

/** A lane's heading inside a menu. Every lane but the first has a rule above it. */
export function Lane({ label }: { readonly label: string }): JSX.Element {
  return (
    <div className="mt-1.5 border-t border-line-soft px-2 pt-2 pb-[3px] first:mt-0 first:border-t-0 first:pt-1 [input+&]:mt-0 [input+&]:border-t-0 [input+&]:pt-1">
      <span className="text-label font-emph tracking-[0.1em] text-faint uppercase">{label}</span>
    </div>
  );
}

/** Wraps a provider's logo for a row's marker column, in place of the dot. */
export const renderMarker = (mark: ReactNode): ReactNode => (
  <span className="flex w-4 justify-center opacity-85">{mark}</span>
);

/** A menu's first row: the label of what is being picked, and an optional note on the right. */
export function MenuHeader({
  label,
  note,
}: {
  readonly label: string;
  readonly note?: string | undefined;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 px-2 pt-1.5 pb-[5px]">
      <span className="text-label font-emph tracking-[0.1em] whitespace-nowrap text-faint uppercase">
        {label}
      </span>
      {note === undefined ? null : (
        <span className="ml-auto font-mono text-[10.5px] whitespace-nowrap text-faint">{note}</span>
      )}
    </div>
  );
}

/** The fine print at the bottom of a menu. */
export function MenuFoot({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="mt-1.5 border-t border-line-soft px-2 pt-[7px] pb-[3px] text-[11.5px] leading-[1.45] text-faint">
      {children}
    </div>
  );
}
