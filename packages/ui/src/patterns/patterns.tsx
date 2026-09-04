import type { JSX, ReactNode } from "react";
import { Label } from "../primitives/label";

/**
 * What a screen with nothing on it says: a headline, a sentence about what will
 * be here, whatever it offers, and fine print for the detail underneath.
 */
export function EmptyState({
  headline,
  lead,
  fine,
  children,
}: {
  readonly headline: string;
  readonly lead?: string | undefined;
  readonly fine?: ReactNode;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div className="mt-[4vh] flex max-w-[560px] flex-col gap-3.5">
      <h2 className="text-[17px] font-emph tracking-[-0.01em] text-balance text-ink">{headline}</h2>
      {lead === undefined ? null : <p className="max-w-[52ch] text-row text-muted">{lead}</p>}
      {children}
      {fine === undefined ? null : <p className="max-w-[56ch] text-fine text-faint">{fine}</p>}
    </div>
  );
}

/** An uppercase lane label; the one heading style above a group of rows. */
export function LaneLabel({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="mb-2.5 text-label font-emph tracking-[0.1em] text-faint uppercase">
      {children}
    </div>
  );
}

/** A passive container for rows. */
export function Group({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div className="max-w-[560px] rounded-card border border-line-soft bg-surface px-1.5 py-1">
      {children}
    </div>
  );
}

/** One labelled field with the message its own validation produced, if any. */
export function Field({
  id,
  label,
  error,
  children,
}: {
  readonly id: string;
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

/** A card: a lane label, its rows, and the fine print under them. */
export function FormCard({
  label,
  fine,
  children,
}: {
  readonly label: string;
  readonly fine?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex max-w-[520px] flex-col gap-2 rounded-card border border-line bg-raised px-4.5 py-3.5 shadow-card">
      <div className="text-label font-emph tracking-[0.1em] text-faint uppercase">{label}</div>
      {children}
      {fine === undefined ? null : <p className="text-fine text-faint">{fine}</p>}
    </section>
  );
}

/** One labelled row of a card. */
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
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-baseline gap-3 text-row">
      <label
        htmlFor={htmlFor}
        className="text-[10px] font-emph tracking-[0.09em] text-faint uppercase"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
