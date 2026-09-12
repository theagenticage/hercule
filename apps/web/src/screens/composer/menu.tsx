import type { JSX, ReactNode } from "react";
import { cn } from "@hydra/ui";

/**
 * One row of a composer menu: a marker column (the dot on the row in force, or
 * a provider's mark), the name with its small detail beside it, a note at the
 * right, and a sub-line under both.
 *
 * A dimmed row is not a button. It is inert - "dimmed with the reason, never
 * hidden" (spec 14 §The composer) means the row stays on show and stops
 * answering - and the one affordance it may still carry, a login, is a control
 * of its own in the trailing slot, which could not be nested inside a button.
 */
export function MenuRow({
  marker,
  name,
  detail,
  note,
  sub,
  current = false,
  dimmed = null,
  trailing,
  className,
  onPick,
}: {
  /** What stands in the marker column; the row's own dot when nothing does. */
  readonly marker?: ReactNode;
  readonly name: ReactNode;
  /** The small word beside the name: an account, a plan, "default". */
  readonly detail?: string | null;
  readonly note?: ReactNode;
  readonly sub?: ReactNode;
  readonly current?: boolean;
  readonly dimmed?: string | null;
  readonly trailing?: ReactNode;
  /** What this row wears beyond the row treatment: a rule above it, say. */
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
      <span className="min-w-0 truncate">
        {name}
        {detail === undefined || detail === null || detail === "" ? null : (
          <span className="ml-1.5 text-[11px] font-normal text-faint">{detail}</span>
        )}
      </span>{" "}
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-[11px] font-normal whitespace-nowrap",
          marker !== undefined && current ? "text-ink" : "text-faint",
        )}
      >
        {note ?? dimmed}
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
    "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 rounded-[6px]",
    // A row that carries a mark is a model row: a shade taller, and in ink.
    marker === undefined ? "px-2 py-[5px]" : "px-2 py-1.5",
    "text-left text-meta",
    current && "font-emph",
    current || (marker !== undefined && dimmed === null) ? "text-ink" : "text-muted",
    className,
  );

  if (dimmed !== null) {
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

/** A lane's own heading inside a menu; the first one carries no rule above it. */
export function Lane({ label }: { readonly label: string }): JSX.Element {
  return (
    <div className="mt-1.5 border-t border-line-soft px-2 pt-2 pb-[3px] first:mt-0 first:border-t-0 first:pt-1 [input+&]:mt-0 [input+&]:border-t-0 [input+&]:pt-1">
      <span className="text-label font-emph tracking-[0.1em] text-faint uppercase">{label}</span>
    </div>
  );
}

/** The marker column of a row that carries a provider's mark rather than a dot. */
export const markerOf = (mark: ReactNode): ReactNode => (
  <span className="flex w-4 justify-center opacity-85">{mark}</span>
);

/** A menu's own first row: what is being picked, and what picking it settles. */
export function MenuHeader({
  label,
  note,
}: {
  readonly label: string;
  readonly note?: string | undefined;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 px-2 pt-1.5 pb-[5px]">
      <span className="text-label font-emph tracking-[0.1em] text-faint uppercase">{label}</span>
      {note === undefined ? null : (
        <span className="ml-auto font-mono text-[10.5px] whitespace-nowrap text-faint">{note}</span>
      )}
    </div>
  );
}

/** The fine print under a menu: what it will offer, and does not yet. */
export function MenuFoot({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="mt-1.5 border-t border-line-soft px-2 pt-[7px] pb-[3px] text-[11.5px] leading-[1.45] text-faint">
      {children}
    </div>
  );
}
