import type { JSX, ReactNode } from "react";
import { cn } from "../primitives/cn";
import { Label } from "../primitives/label";

/**
 * What a screen shows when it has nothing to show yet: a headline, a lead
 * sentence about what will appear here, any actions (`children`), and fine
 * print with further detail.
 *
 * It sits a little below the screen's header by default. A settings screen
 * passes `className="mt-0"`, so its empty state starts under the settings
 * tabs where the cards of the other settings screens start.
 */
export function EmptyState({
  headline,
  lead,
  fine,
  className,
  children,
}: {
  readonly headline: string;
  readonly lead?: string | undefined;
  readonly fine?: ReactNode;
  readonly className?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className={cn("mt-[4vh] flex max-w-[560px] flex-col gap-3.5", className)}>
      <h2 className="text-[17px] font-emph tracking-[-0.01em] text-balance text-ink">{headline}</h2>
      {lead === undefined ? null : <p className="max-w-[52ch] text-row text-muted">{lead}</p>}
      {children}
      {fine === undefined ? null : <p className="max-w-[56ch] text-fine text-faint">{fine}</p>}
    </div>
  );
}

/** An uppercase lane label: the heading style used above every group of rows. */
export function LaneLabel({
  className,
  id,
  children,
}: {
  readonly className?: string;
  /** The id a group passes to `aria-labelledby`, so this label becomes its name. */
  readonly id?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      id={id}
      className={cn("mb-2.5 text-label font-emph tracking-[0.1em] text-faint uppercase", className)}
    >
      {children}
    </div>
  );
}

/**
 * Renders a passive container for rows. It is as wide as a `FormCard`, so a
 * list and the cards under it share one right edge.
 */
export function Group({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="max-w-[568px] rounded-card border border-line-soft bg-surface px-1.5 py-1">
      {children}
    </div>
  );
}

/** One labelled field, with its validation error below it, if there is one. */
export function Field({
  id,
  label,
  error,
  children,
}: {
  /**
   * The id of the control the label focuses. Leave it out when the child is a
   * group of controls: the group names itself, and a label that points at a
   * missing element focuses nothing.
   */
  readonly id?: string | undefined;
  readonly label: string;
  readonly error?: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error === undefined ? null : (
        <p className="text-fine text-fail" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * A card: a heading, its rows, and optional fine print under them.
 *
 * A string `label` renders as an uppercase lane label, for a card named after
 * a section of settings. A card about one record passes a node instead, so the
 * record's name renders exactly as the caller wrote it.
 */
export function FormCard({
  label,
  fine,
  children,
}: {
  readonly label: ReactNode;
  readonly fine?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex max-w-[568px] flex-col gap-2 rounded-card border border-line bg-raised px-4.5 py-3.5 shadow-card">
      {typeof label === "string" ? (
        <div className="text-label font-emph tracking-[0.1em] text-faint uppercase">{label}</div>
      ) : (
        label
      )}
      {children}
      {fine === undefined ? null : <p className="text-fine text-faint">{fine}</p>}
    </section>
  );
}

/** The small uppercase style of a card row's label. */
const ROW_LABEL = "text-[10px] font-emph tracking-[0.09em] whitespace-nowrap text-faint uppercase";

/**
 * Renders one labelled row of a card: the label in its own column, the
 * control beside it.
 *
 * The label column is as wide as the longest label, "Default GitHub account",
 * so no label breaks onto a second line, and every row on a page puts its
 * control at the same x. A card is 568px wide so that the control column
 * beside it still holds the four access modes of a compact segmented control.
 */
export function Row({
  label,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly htmlFor?: string | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-baseline gap-3 text-row">
      <label htmlFor={htmlFor} className={ROW_LABEL}>
        {label}
      </label>
      {children}
    </div>
  );
}
