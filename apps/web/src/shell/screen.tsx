import type { JSX, ReactNode } from "react";
import { Button } from "@hydra/ui";

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

export interface Offer {
  readonly name: string;
  readonly gist: string;
}

/**
 * The Connect rows an empty screen offers. Connection setup does not exist yet,
 * so every button is disabled with the reason under the group: what cannot be
 * picked is dimmed with its reason, never hidden.
 */
export function ConnectRows({
  offers,
  reason,
}: {
  readonly offers: readonly Offer[];
  readonly reason: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Group>
        {offers.map((offer) => (
          <div
            key={offer.name}
            className="flex items-center gap-2.5 rounded-control px-2.5 py-[7px] text-row"
          >
            <span className="min-w-0 flex-1">
              <b className="block font-emph text-ink">{offer.name}</b>
              <small className="block text-fine text-muted">{offer.gist}</small>
            </span>
            <Button variant="primary" disabled>
              Connect
            </Button>
          </div>
        ))}
      </Group>
      <p className="text-fine text-faint">{reason}</p>
    </div>
  );
}
